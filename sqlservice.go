package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/databricks/databricks-sdk-go/service/catalog"
	"github.com/databricks/databricks-sdk-go/service/sql"
	"github.com/wailsapp/wails/v3/pkg/application"

	"dbx-desktop/internal/queries"
	"dbx-desktop/internal/settings"
	"dbx-desktop/internal/sqlexec"
	"dbx-desktop/internal/wsfiles"
)

const browseTimeout = 30 * time.Second

// QueryTab is an open query file with its content.
type QueryTab struct {
	File    queries.File `json:"file"`
	Content string       `json:"content"`
	// Remote is set when the file is the local copy of a workspace file.
	Remote *RemoteFile `json:"remote,omitempty"`
}

// SQLWorkspaceState is what the scratchpad restores when it opens.
type SQLWorkspaceState struct {
	// Dir is the folder new query files are created in for this workspace.
	Dir         string     `json:"dir"`
	WarehouseID string     `json:"warehouseId"`
	Tabs        []QueryTab `json:"tabs"`
	ActiveTab   string     `json:"activeTab"`
	// Trash is true when deleted query files go to the system trash.
	Trash bool `json:"trash"`
}

// DeleteResult reports which query files were deleted and why others were not.
type DeleteResult struct {
	Deleted []string `json:"deleted"`
	// Errors holds one message per file that could not be deleted.
	Errors []string `json:"errors"`
}

// TableRef is a table or view in a schema.
type TableRef struct {
	Name     string `json:"name"`
	FullName string `json:"fullName"`
	Type     string `json:"type"`
}

// SQLService backs the SQL scratchpad: query files, running statements, the
// catalog tree, warehouse controls and history.
type SQLService struct {
	pool       *clientPool
	store      *settings.Store
	historyDir string
	// mirrorDir holds local copies of workspace files, one folder per profile.
	mirrorDir string

	mu      sync.Mutex
	running map[string]context.CancelFunc
	mirrors map[string]*wsfiles.Mirror
}

// NewSQLService shares the workspace service's clients and settings.
func NewSQLService(ws *WorkspaceService) (*SQLService, error) {
	settingsPath, err := settings.DefaultPath()
	if err != nil {
		return nil, err
	}
	return &SQLService{
		pool:       ws.pool,
		store:      ws.store,
		historyDir: filepath.Join(filepath.Dir(settingsPath), "history"),
		mirrorDir:  filepath.Join(filepath.Dir(settingsPath), "workspace"),
		running:    map[string]context.CancelFunc{},
		mirrors:    map[string]*wsfiles.Mirror{},
	}, nil
}

func (s *SQLService) dir(profile string) (string, error) {
	_, root, err := s.store.SQL(profile)
	if err != nil {
		return "", err
	}
	if root == "" {
		if root, err = queries.DefaultRoot(); err != nil {
			return "", err
		}
	}
	return queries.Dir(root, profile), nil
}

// State returns the saved scratchpad state for a workspace. Tabs whose files
// no longer exist are dropped.
func (s *SQLService) State(profile string) (SQLWorkspaceState, error) {
	out := SQLWorkspaceState{Tabs: []QueryTab{}}
	st, _, err := s.store.SQL(profile)
	if err != nil {
		return out, err
	}
	if out.Dir, err = s.dir(profile); err != nil {
		return out, err
	}
	out.WarehouseID = st.WarehouseID
	out.Trash = queries.HasTrash()
	for _, path := range st.Tabs {
		tab, err := s.OpenQueryFile(path)
		if err != nil {
			continue
		}
		tab.Remote = s.remoteInfo(profile, path, tab.Content)
		out.Tabs = append(out.Tabs, tab)
		if path == st.ActiveTab {
			out.ActiveTab = path
		}
	}
	return out, nil
}

// SaveState remembers the chosen warehouse and which tabs are open.
func (s *SQLService) SaveState(profile, warehouseID string, tabs []string, activeTab string) error {
	if tabs == nil {
		tabs = []string{}
	}
	return s.store.SetSQL(profile, settings.SQLState{WarehouseID: warehouseID, Tabs: tabs, ActiveTab: activeTab})
}

// NewQueryFile creates an empty Untitled-N.sql in the workspace's folder.
func (s *SQLService) NewQueryFile(profile string) (QueryTab, error) {
	dir, err := s.dir(profile)
	if err != nil {
		return QueryTab{}, err
	}
	f, err := queries.NewUntitled(dir)
	return QueryTab{File: f}, err
}

// ListQueryFiles lists the .sql files in the workspace's folder, newest first.
func (s *SQLService) ListQueryFiles(profile string) ([]queries.File, error) {
	dir, err := s.dir(profile)
	if err != nil {
		return nil, err
	}
	return queries.List(dir)
}

// OpenQueryFile reads a .sql file from anywhere on disk.
func (s *SQLService) OpenQueryFile(path string) (QueryTab, error) {
	content, err := queries.Read(path)
	if err != nil {
		return QueryTab{}, cleanFileErr(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		return QueryTab{}, cleanFileErr(err)
	}
	return QueryTab{
		File:    queries.File{Path: path, Name: filepath.Base(path), Modified: st.ModTime().UnixMilli()},
		Content: content,
	}, nil
}

// WriteQueryFile saves a query's text to its file.
func (s *SQLService) WriteQueryFile(path, content string) error {
	return cleanFileErr(queries.Write(path, content))
}

// RenameQueryFile renames a query file within its folder.
func (s *SQLService) RenameQueryFile(path, newName string) (queries.File, error) {
	f, err := queries.Rename(path, newName)
	return f, cleanFileErr(err)
}

// DeleteQueryFiles moves query files in the workspace's scratch folder to the
// trash, or removes them where there is none. Files outside that folder are
// refused.
func (s *SQLService) DeleteQueryFiles(profile string, paths []string) (DeleteResult, error) {
	out := DeleteResult{Deleted: []string{}, Errors: []string{}}
	dir, err := s.dir(profile)
	if err != nil {
		return out, err
	}
	for _, p := range paths {
		if err := queries.Delete(dir, p); err != nil {
			out.Errors = append(out.Errors, cleanFileErr(err).Error())
			continue
		}
		out.Deleted = append(out.Deleted, p)
	}
	return out, nil
}

// PickQueryFile shows the native open dialog for a .sql file. It returns an
// empty path when the user cancels.
func (s *SQLService) PickQueryFile() (string, error) {
	app := application.Get()
	if app == nil {
		return "", errors.New("the file dialog is not available")
	}
	return app.Dialog.OpenFile().
		SetTitle("Open SQL file").
		AddFilter("SQL files", "*.sql").
		CanChooseFiles(true).
		PromptForSingleSelection()
}

// SaveTextFile shows the native save dialog and writes content to the chosen
// file. It returns an empty path when the user cancels.
func (s *SQLService) SaveTextFile(suggestedName, content string) (string, error) {
	app := application.Get()
	if app == nil {
		return "", errors.New("the file dialog is not available")
	}
	path, err := app.Dialog.SaveFile().
		SetFilename(suggestedName).
		AddFilter("CSV files", "*.csv").
		PromptForSingleSelection()
	if err != nil || path == "" {
		return "", err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", cleanFileErr(err)
	}
	return path, nil
}

// ListWarehouses returns the workspace's SQL warehouses, running ones first.
func (s *SQLService) ListWarehouses(profile string) ([]Warehouse, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), browseTimeout)
	defer cancel()
	list, err := warehouses(ctx, c)
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	return list, nil
}

// StartWarehouse asks a warehouse to start. It returns once the request is
// accepted, not when the warehouse is running.
func (s *SQLService) StartWarehouse(profile, id string) error {
	c, err := s.pool.get(profile)
	if err != nil {
		return errors.New(cleanErr(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), browseTimeout)
	defer cancel()
	if _, err := c.warehouses.Start(ctx, sql.StartRequest{Id: id}); err != nil {
		return errors.New(cleanErr(err))
	}
	return nil
}

// StopWarehouse asks a warehouse to stop. Queries running on it are ended.
func (s *SQLService) StopWarehouse(profile, id string) error {
	c, err := s.pool.get(profile)
	if err != nil {
		return errors.New(cleanErr(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), browseTimeout)
	defer cancel()
	if _, err := c.warehouses.Stop(ctx, sql.StopRequest{Id: id}); err != nil {
		return errors.New(cleanErr(err))
	}
	return nil
}

// ListCatalogs returns catalog names, sorted.
func (s *SQLService) ListCatalogs(profile string) ([]string, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), browseTimeout)
	defer cancel()
	list, err := c.catalogs.ListAll(ctx, catalog.ListCatalogsRequest{})
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	names := make([]string, 0, len(list))
	for _, x := range list {
		names = append(names, x.Name)
	}
	sortFold(names)
	return names, nil
}

// CatalogPrefs returns which catalogs the browser shows for a workspace and
// which one was open last. An empty Visible list means all catalogs.
func (s *SQLService) CatalogPrefs(profile string) (settings.CatalogPrefs, error) {
	p, err := s.store.Catalogs(profile)
	if p.Visible == nil {
		p.Visible = []string{}
	}
	return p, err
}

// SaveCatalogPrefs remembers which catalogs to show and which one is open.
func (s *SQLService) SaveCatalogPrefs(profile string, p settings.CatalogPrefs) error {
	seen := map[string]bool{}
	visible := make([]string, 0, len(p.Visible))
	for _, name := range p.Visible {
		name = strings.TrimSpace(name)
		if name != "" && !seen[name] {
			seen[name] = true
			visible = append(visible, name)
		}
	}
	sortFold(visible)
	p.Visible = visible
	p.Current = strings.TrimSpace(p.Current)
	return s.store.SetCatalogs(profile, p)
}

// ListSchemas returns the schema names in a catalog, sorted.
func (s *SQLService) ListSchemas(profile, catalogName string) ([]string, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), browseTimeout)
	defer cancel()
	list, err := c.schemas.ListAll(ctx, catalog.ListSchemasRequest{CatalogName: catalogName})
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	names := make([]string, 0, len(list))
	for _, x := range list {
		names = append(names, x.Name)
	}
	sortFold(names)
	return names, nil
}

// ListTables returns the tables and views in a schema, sorted by name.
func (s *SQLService) ListTables(profile, catalogName, schemaName string) ([]TableRef, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), browseTimeout)
	defer cancel()
	list, err := c.tables.ListAll(ctx, catalog.ListTablesRequest{
		CatalogName:    catalogName,
		SchemaName:     schemaName,
		OmitColumns:    true,
		OmitProperties: true,
	})
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	out := make([]TableRef, 0, len(list))
	for _, t := range list {
		out = append(out, TableRef{Name: t.Name, FullName: t.FullName, Type: string(t.TableType)})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// TableColumns returns a table's columns in their defined order.
func (s *SQLService) TableColumns(profile, fullName string) ([]sqlexec.Column, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), browseTimeout)
	defer cancel()
	t, err := c.tables.Get(ctx, catalog.GetTableRequest{FullName: fullName})
	if err != nil {
		return nil, errors.New(cleanErr(err))
	}
	cols := append([]catalog.ColumnInfo(nil), t.Columns...)
	sort.SliceStable(cols, func(i, j int) bool { return cols[i].Position < cols[j].Position })
	out := make([]sqlexec.Column, 0, len(cols))
	for _, col := range cols {
		out = append(out, sqlexec.Column{Name: col.Name, Type: col.TypeText})
	}
	return out, nil
}

// RunQuery runs one statement on a warehouse and waits for the result. runID
// is chosen by the caller so it can cancel the run with CancelQuery.
func (s *SQLService) RunQuery(profile, warehouseID, statement, runID string) sqlexec.Result {
	statement = strings.TrimSpace(statement)
	if statement == "" {
		return emptyResult("There is no statement to run.")
	}
	if warehouseID == "" {
		return emptyResult("Choose a SQL warehouse first.")
	}
	c, err := s.pool.get(profile)
	if err != nil {
		return emptyResult(cleanErr(err))
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.running[runID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, runID)
		s.mu.Unlock()
		cancel()
	}()

	res := sqlexec.Run(ctx, c.api, warehouseID, statement)
	if res.Status == "FAILED" {
		res.Error = cleanErr(errors.New(res.Error))
	}

	// History is a convenience; a failure to record it must not hide the result.
	_ = queries.AppendHistory(queries.HistoryPath(s.historyDir, profile), queries.HistoryEntry{
		Time:        time.Now().UnixMilli(),
		Statement:   statement,
		WarehouseID: warehouseID,
		Status:      res.Status,
		RowCount:    len(res.Rows),
		DurationMs:  res.DurationMs,
		Error:       res.Error,
	})
	return res
}

func emptyResult(msg string) sqlexec.Result {
	return sqlexec.Result{Status: "FAILED", Error: msg, Columns: []sqlexec.Column{}, Rows: [][]*string{}}
}

// CancelQuery cancels a running statement started with the same runID.
func (s *SQLService) CancelQuery(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel, ok := s.running[runID]; ok {
		cancel()
	}
}

// History returns the statements run in a workspace, newest first.
func (s *SQLService) History(profile string) ([]queries.HistoryEntry, error) {
	return queries.ReadHistory(queries.HistoryPath(s.historyDir, profile))
}

func sortFold(names []string) {
	sort.SliceStable(names, func(i, j int) bool {
		return strings.ToLower(names[i]) < strings.ToLower(names[j])
	})
}

// cleanFileErr turns file-system errors into short messages without Go's
// "open /path:" prefix noise.
func cleanFileErr(err error) error {
	if err == nil {
		return nil
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		name := filepath.Base(pe.Path)
		switch {
		case errors.Is(err, os.ErrNotExist):
			return fmt.Errorf("%s no longer exists", name)
		case errors.Is(err, os.ErrPermission):
			return fmt.Errorf("you do not have permission to access %s", name)
		}
	}
	return err
}
