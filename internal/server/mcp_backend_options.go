package server

import "github.com/danieles/specola/internal/mcpserver"

// mcpBackendOptions gives the MCP server what its backend tools need
// (docs/page-backends.md, "MCP (step 7)"): the runner, for backend_logs and
// backend_query, and CallBackendAs, so that call_backend goes through
// exactly what the viewer's /api/pages/{id}/x goes through. Nothing when
// backends are disabled: the tools aren't offered then.
func (s *Server) mcpBackendOptions(opts *mcpserver.Options) {
	if s.runner == nil {
		return
	}
	opts.Runner = s.runner
	opts.CallBackend = s.CallBackendAs
}
