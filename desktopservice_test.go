package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"dbx-desktop/internal/settings"
)

type fakeDesktopNotifier struct {
	allowed    bool
	startupErr error
	sendErr    error
	sent       []notifications.NotificationOptions
	response   func(notifications.NotificationResult)
}

func (f *fakeDesktopNotifier) ServiceStartup(context.Context, application.ServiceOptions) error {
	return f.startupErr
}
func (f *fakeDesktopNotifier) ServiceShutdown() error                          { return nil }
func (f *fakeDesktopNotifier) CheckNotificationAuthorization() (bool, error)   { return f.allowed, nil }
func (f *fakeDesktopNotifier) RequestNotificationAuthorization() (bool, error) { return f.allowed, nil }
func (f *fakeDesktopNotifier) SendNotification(n notifications.NotificationOptions) error {
	f.sent = append(f.sent, n)
	return f.sendErr
}
func (f *fakeDesktopNotifier) OnNotificationResponse(fn func(notifications.NotificationResult)) {
	f.response = fn
}

func testDesktop(t *testing.T) (*DesktopService, *fakeDesktopNotifier) {
	t.Helper()
	f := &fakeDesktopNotifier{allowed: true}
	s, err := NewDesktopService(settings.New(filepath.Join(t.TempDir(), "settings.json")))
	if err != nil {
		t.Fatal(err)
	}
	s.notifier = f
	if err := s.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetNotifications(true); err != nil {
		t.Fatal(err)
	}
	return s, f
}

func TestCompletionsRespectFocusPreferencesAndCancellation(t *testing.T) {
	for _, tc := range []struct {
		name, status, kind string
		focused, disabled  bool
		want               int
	}{
		{name: "background success", status: "finished", kind: "sql", want: 1},
		{name: "background failure", status: "failed", kind: "notebooks", want: 1},
		{name: "Python exception", status: "error", kind: "notebooks", want: 1},
		{name: "foreground", status: "finished", kind: "sql", focused: true},
		{name: "disabled", status: "failed", kind: "sql", disabled: true},
		{name: "cancelled", status: "cancelled", kind: "notebooks"},
		{name: "unknown status", status: "running", kind: "sql"},
		{name: "unknown view", status: "finished", kind: "other"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := testDesktop(t)
			s.focused = func() bool { return tc.focused }
			if tc.disabled {
				if err := s.SetNotifications(false); err != nil {
					t.Fatal(err)
				}
			}
			s.NotifyCompletion(Completion{ID: "run-1", Kind: tc.kind, Profile: "dev", Path: "/draft.sql", Name: "draft.sql", Status: tc.status})
			if len(f.sent) != tc.want {
				t.Fatalf("got %d notifications, want %d", len(f.sent), tc.want)
			}
			if tc.want > 0 {
				n := f.sent[0]
				if n.Data["profile"] != "dev" || n.Data["path"] != "/draft.sql" || len(n.Data) != 3 {
					t.Fatalf("wrong destination: %+v", n)
				}
				if tc.status == "failed" && !strings.Contains(n.Title, "failed") {
					t.Fatalf("wrong title: %s", n.Title)
				}
			}
		})
	}
}

func TestNotificationClickReopensOriginalWorkspaceAndTab(t *testing.T) {
	s, f := testDesktop(t)
	var opened []Completion
	s.open = func(c Completion) { opened = append(opened, c) }
	r := notifications.NotificationResult{Response: notifications.NotificationResponse{
		ActionIdentifier: notifications.DefaultActionIdentifier,
		UserInfo:         map[string]interface{}{"profile": "original", "kind": "notebooks", "path": "/original.py"},
	}}
	f.response(r)
	if len(opened) != 1 || opened[0].Profile != "original" || opened[0].Path != "/original.py" || opened[0].Kind != "notebooks" {
		t.Fatalf("wrong target: %+v", opened)
	}
	r.Response.ActionIdentifier = "dismissed"
	f.response(r)
	if len(opened) != 1 {
		t.Fatal("dismissal opened a tab")
	}
}

func TestDeniedPermissionDoesNotEnableNotifications(t *testing.T) {
	s, f := testDesktop(t)
	if err := s.SetNotifications(false); err != nil {
		t.Fatal(err)
	}
	f.allowed = false
	if err := s.SetNotifications(true); err == nil {
		t.Fatal("expected a permission error")
	}
	prefs, err := s.store.Desktop()
	if err != nil || prefs.Notifications || s.State().Preferences.Notifications {
		t.Fatal("denied permission enabled notifications")
	}
}

func TestDesktopPreferenceWriteFailureKeepsCurrentBehavior(t *testing.T) {
	s, _ := testDesktop(t)
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.store = settings.New(filepath.Join(blocker, "settings.json"))
	if err := s.SetKeepInTray(false); err == nil {
		t.Fatal("expected a write error")
	}
	if !s.keepInTray() {
		t.Fatal("failed save changed close behavior")
	}
	if err := s.SetNotifications(false); err == nil {
		t.Fatal("expected a write error")
	}
	if !s.State().Preferences.Notifications {
		t.Fatal("failed save changed notification behavior")
	}
}

func TestUnavailableNotificationsDoNotPreventAppStartup(t *testing.T) {
	s, f := testDesktop(t)
	f.startupErr = errors.New("no desktop notification service")
	if err := s.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	st := s.State()
	if st.NotificationsAvailable || st.NotificationError == "" {
		t.Fatalf("missing availability error: %+v", st)
	}
	if err := s.SetNotifications(true); err == nil {
		t.Fatal("enabled unavailable notifications")
	}
}

func TestNotificationDeliveryFailureIsVisibleInSettings(t *testing.T) {
	s, f := testDesktop(t)
	f.sendErr = errors.New("notification delivery failed")
	s.NotifyCompletion(Completion{ID: "r", Kind: "sql", Profile: "dev", Path: "/q.sql", Name: "q.sql", Status: "finished"})
	if !strings.Contains(s.State().NotificationError, "delivery failed") {
		t.Fatal("lost delivery failure")
	}
	// The test button intentionally works in the foreground.
	s.focused = func() bool { return true }
	f.sendErr = nil
	if err := s.TestNotification(); err != nil {
		t.Fatal(err)
	}
	if len(f.sent) != 2 {
		t.Fatal("test notification was suppressed")
	}
}
