package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"dbx-desktop/internal/settings"
)

// Completion identifies the tab to reopen. SQL, output and error details never
// leave the app through a desktop notification.
type Completion struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Profile string `json:"profile"`
	Path    string `json:"path"`
	Name    string `json:"name"`
	Status  string `json:"status"`
}

type DesktopState struct {
	Preferences            settings.DesktopPrefs `json:"preferences"`
	NotificationsAvailable bool                  `json:"notificationsAvailable"`
	NotificationsAllowed   bool                  `json:"notificationsAllowed"`
	NotificationError      string                `json:"notificationError"`
}

type desktopNotifier interface {
	ServiceStartup(context.Context, application.ServiceOptions) error
	ServiceShutdown() error
	CheckNotificationAuthorization() (bool, error)
	RequestNotificationAuthorization() (bool, error)
	SendNotification(notifications.NotificationOptions) error
	OnNotificationResponse(func(notifications.NotificationResult))
}

// DesktopService owns desktop preferences and notification delivery. Hiding the
// existing window preserves its JS run chains, results and Python sessions.
type DesktopService struct {
	store             *settings.Store
	notifier          desktopNotifier
	mu                sync.Mutex
	prefs             settings.DesktopPrefs
	ready             bool
	notificationError string
	focused           func() bool
	open              func(Completion)
	quitting          atomic.Bool
}

func NewDesktopService(store *settings.Store) (*DesktopService, error) {
	prefs, err := store.Desktop()
	if err != nil {
		return nil, err
	}
	return &DesktopService{store: store, notifier: notifications.New(), prefs: prefs}, nil
}

func (s *DesktopService) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	// Notification support is optional, including in server/development builds
	// without an application bundle. Its failure must not prevent app startup.
	err := s.notifier.ServiceStartup(ctx, options)
	s.mu.Lock()
	s.ready = err == nil
	if err != nil {
		s.notificationError = err.Error()
	}
	s.mu.Unlock()
	s.notifier.OnNotificationResponse(func(result notifications.NotificationResult) {
		if result.Error != nil || result.Response.ActionIdentifier != notifications.DefaultActionIdentifier {
			return
		}
		data := result.Response.UserInfo
		kind, _ := data["kind"].(string)
		profile, _ := data["profile"].(string)
		path, _ := data["path"].(string)
		if s.open != nil {
			s.open(Completion{Kind: kind, Profile: profile, Path: path})
		}
	})
	return nil
}

func (s *DesktopService) ServiceShutdown() error {
	s.mu.Lock()
	ready := s.ready
	s.ready = false
	s.mu.Unlock()
	if ready {
		return s.notifier.ServiceShutdown()
	}
	return nil
}

func (s *DesktopService) State() DesktopState {
	s.mu.Lock()
	st := DesktopState{Preferences: s.prefs, NotificationsAvailable: s.ready, NotificationError: s.notificationError}
	s.mu.Unlock()
	if st.NotificationsAvailable {
		allowed, err := s.notifier.CheckNotificationAuthorization()
		st.NotificationsAllowed = allowed
		if err != nil {
			st.NotificationError = err.Error()
		}
	}
	return st
}

func (s *DesktopService) SetKeepInTray(enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefs := s.prefs
	prefs.KeepInTray = enabled
	if err := s.store.SetDesktop(prefs); err != nil {
		return err
	}
	s.prefs = prefs
	return nil
}

func (s *DesktopService) SetNotifications(enabled bool) error {
	if enabled {
		s.mu.Lock()
		ready := s.ready
		s.mu.Unlock()
		if !ready {
			return errors.New("desktop notifications are unavailable in this build; use the packaged desktop app")
		}
		allowed, err := s.notifier.RequestNotificationAuthorization()
		if err != nil {
			if runtime.GOOS == "darwin" {
				return fmt.Errorf("could not enable notifications: %w. Use a signed app bundle and allow dbx-desktop in System Settings > Notifications", err)
			}
			return err
		}
		if !allowed {
			return errors.New("notifications are blocked; allow dbx-desktop in your system notification settings, then try again")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	prefs := s.prefs
	prefs.Notifications = enabled
	if err := s.store.SetDesktop(prefs); err != nil {
		return err
	}
	s.prefs = prefs
	s.notificationError = ""
	return nil
}

// NotifyCompletion is called once per SQL statement or notebook run chain,
// after its results have been stored in the view. Cancellations stay silent.
func (s *DesktopService) NotifyCompletion(c Completion) {
	// Notebook code exceptions use "error"; execution/transport failures use "failed".
	if c.Status == "error" {
		c.Status = "failed"
	}
	if c.Status != "finished" && c.Status != "failed" {
		return
	}
	if (c.Kind != "sql" && c.Kind != "notebooks") || c.Profile == "" || c.Path == "" {
		return
	}
	s.mu.Lock()
	enabled := s.prefs.Notifications && s.ready
	s.mu.Unlock()
	if !enabled || (s.focused != nil && s.focused()) {
		return
	}
	title := "Query finished"
	if c.Kind == "notebooks" {
		title = "Notebook run finished"
	}
	if c.Status == "failed" {
		title = "Query failed"
		if c.Kind == "notebooks" {
			title = "Notebook run failed"
		}
	}
	err := s.notifier.SendNotification(notifications.NotificationOptions{
		ID: "completion-" + c.ID, Title: title,
		Body: fmt.Sprintf("%s · %s. Click to view results.", c.Profile, c.Name),
		Data: map[string]interface{}{"kind": c.Kind, "profile": c.Profile, "path": c.Path},
	})
	if err != nil {
		s.mu.Lock()
		s.notificationError = err.Error()
		s.mu.Unlock()
		log.Printf("completion notification: %v", err)
	}
}

func (s *DesktopService) TestNotification() error {
	s.mu.Lock()
	enabled := s.prefs.Notifications && s.ready
	s.mu.Unlock()
	if !enabled {
		return errors.New("enable completion notifications first")
	}
	return s.notifier.SendNotification(notifications.NotificationOptions{
		ID: fmt.Sprintf("test-%d", time.Now().UnixNano()), Title: "Notifications are ready",
		Body: "You'll hear when queries and notebook runs finish while you're working elsewhere.",
	})
}

func (s *DesktopService) keepInTray() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.prefs.KeepInTray
}

func (s *DesktopService) attach(app *application.App, window *application.WebviewWindow) {
	app.OnShutdown(func() { s.quitting.Store(true) })
	restore := func() { window.Restore(); window.Show(); window.Focus() }
	s.focused = func() bool { return window.IsVisible() && window.IsFocused() }
	s.open = func(c Completion) {
		restore()
		if c.Profile != "" && c.Path != "" {
			app.Event.Emit("completion-open", c)
		}
	}
	tray := app.SystemTray.New()
	tray.SetTooltip("dbx-desktop")
	tray.SetIcon(trayIcon(false))
	tray.SetDarkModeIcon(trayIcon(true))
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(trayIcon(false))
	}
	menu := app.NewMenu()
	menu.Add("Open dbx-desktop").OnClick(func(*application.Context) { restore() })
	menu.Add("Settings").OnClick(func(*application.Context) { restore(); app.Event.Emit("desktop-settings") })
	menu.AddSeparator()
	menu.Add("Quit dbx-desktop").OnClick(func(*application.Context) { app.Quit() })
	tray.SetMenu(menu)
	tray.OnClick(tray.ShowMenu)
	tray.OnDoubleClick(restore)
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if s.quitting.Load() {
			return
		}
		e.Cancel()
		if s.keepInTray() {
			window.Hide()
		} else {
			app.Quit()
		}
	})
	app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) { restore() })
}
