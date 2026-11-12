package main

import (
	"sync"

	"github.com/databricks/databricks-sdk-go/client"
	"github.com/databricks/databricks-sdk-go/config"
	"github.com/databricks/databricks-sdk-go/service/catalog"
	"github.com/databricks/databricks-sdk-go/service/iam"
	"github.com/databricks/databricks-sdk-go/service/jobs"
	"github.com/databricks/databricks-sdk-go/service/sql"
	"github.com/databricks/databricks-sdk-go/service/workspace"
)

// apiClients holds only the service clients the app uses. Building these
// directly, not through the SDK's all-in-one WorkspaceClient, keeps every
// unused Databricks service out of the binary.
type apiClients struct {
	api        *client.DatabricksClient
	me         *iam.CurrentUserAPI
	jobs       *jobs.JobsAPI
	warehouses *sql.WarehousesAPI
	catalogs   *catalog.CatalogsAPI
	schemas    *catalog.SchemasAPI
	tables     *catalog.TablesAPI
	workspace  *workspace.WorkspaceAPI
}

// clientPool caches one set of API clients per profile, shared by services.
type clientPool struct {
	cfgPath string
	// cliPath returns the Databricks CLI location, or "" when not installed.
	// OAuth profiles need it to fetch tokens.
	cliPath func() string

	mu      sync.Mutex
	clients map[string]*apiClients
}

func newClientPool(cfgPath string, cliPath func() string) *clientPool {
	return &clientPool{cfgPath: cfgPath, cliPath: cliPath, clients: map[string]*apiClients{}}
}

func (p *clientPool) get(profile string) (*apiClients, error) {
	cli := p.cliPath()

	p.mu.Lock()
	defer p.mu.Unlock()
	if c, ok := p.clients[profile]; ok {
		return c, nil
	}
	api, err := client.New(&config.Config{
		Profile:           profile,
		ConfigFile:        p.cfgPath,
		DatabricksCliPath: cli,
	})
	if err != nil {
		return nil, err
	}
	c := &apiClients{
		api:        api,
		me:         iam.NewCurrentUser(api),
		jobs:       jobs.NewJobs(api),
		warehouses: sql.NewWarehouses(api),
		catalogs:   catalog.NewCatalogs(api),
		schemas:    catalog.NewSchemas(api),
		tables:     catalog.NewTables(api),
		workspace:  workspace.NewWorkspace(api),
	}
	p.clients[profile] = c
	return c, nil
}

// drop forgets a profile's clients, for example after a new sign-in.
func (p *clientPool) drop(profile string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.clients, profile)
}
