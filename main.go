package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// The built frontend is embedded into the binary.
//
//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// Sent to the frontend with the paths of files dropped onto the window.
	application.RegisterEvent[[]string]("files-dropped")
}

func main() {
	workspaces, err := NewWorkspaceService()
	if err != nil {
		log.Fatal(err)
	}
	sqlService, err := NewSQLService(workspaces)
	if err != nil {
		log.Fatal(err)
	}
	notebooks, err := NewNotebookService(workspaces)
	if err != nil {
		log.Fatal(err)
	}

	app := application.New(application.Options{
		Name:        "dbx-desktop",
		Description: "A desktop companion for Databricks",
		Services: []application.Service{
			application.NewService(workspaces),
			application.NewService(sqlService),
			application.NewService(notebooks),
			application.NewService(NewCloudStatusService(workspaces)),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "dbx-desktop",
		Width:     1180,
		Height:    760,
		MinWidth:  860,
		MinHeight: 560,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 44,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(27, 49, 57),
		URL:              "/",
		EnableFileDrop:   true,
	})

	// The webview cannot see the real paths of dropped files, so the window
	// reports them and the frontend decides what to do with them.
	window.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		if files := e.Context().DroppedFiles(); len(files) > 0 {
			app.Event.Emit("files-dropped", files)
		}
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
