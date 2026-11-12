package main

import (
	"context"
	"fmt"
	"sort"

	"dbx-desktop/internal/cloudstatus"
	"dbx-desktop/internal/settings"
)

// CloudStatusService reads public status feeds independently of workspace auth.
type CloudStatusService struct {
	client *cloudstatus.Client
	store  *settings.Store
}

func NewCloudStatusService(workspaces *WorkspaceService) *CloudStatusService {
	return &CloudStatusService{client: cloudstatus.NewClient(), store: workspaces.store}
}

func (s *CloudStatusService) Snapshot(ctx context.Context, refresh bool) []cloudstatus.Provider {
	return s.client.Snapshot(ctx, refresh)
}

func (s *CloudStatusService) Watch() (map[string][]string, error) {
	return s.store.CloudWatch()
}

func (s *CloudStatusService) SaveWatch(watch map[string][]string) error {
	normalized := map[string][]string{}
	for provider, regions := range watch {
		if provider != "aws" && provider != "azure" && provider != "gcp" {
			return fmt.Errorf("Unknown cloud provider %q", provider)
		}
		if len(regions) > 100 {
			return fmt.Errorf("Too many watched regions")
		}
		seen := map[string]bool{}
		for _, id := range regions {
			if id == "" || len(id) > 100 {
				return fmt.Errorf("Invalid region ID")
			}
			if !seen[id] {
				normalized[provider] = append(normalized[provider], id)
				seen[id] = true
			}
		}
		sort.Strings(normalized[provider])
	}
	return s.store.SetCloudWatch(normalized)
}
