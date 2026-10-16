package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
)

// NewAccessTokenVerifier returns a verifier for JWT access tokens issued by
// issuer for resource, as used by the MCP endpoint. It checks the signature
// against the issuer's JWKS (discovered once, keys cached and refreshed by
// go-oidc), plus iss, exp, and that aud contains resource. The token's sub
// becomes TokenInfo.UserID.
func NewAccessTokenVerifier(ctx context.Context, issuer, resource string) (mcpauth.TokenVerifier, error) {
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, err
	}
	// The ID-token verifier is a plain JWT verifier: ClientID is matched
	// against aud, which for an access token is the resource indicator.
	v := provider.Verifier(&oidc.Config{ClientID: resource})
	return func(ctx context.Context, token string, _ *http.Request) (*mcpauth.TokenInfo, error) {
		t, err := v.Verify(ctx, token)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", mcpauth.ErrInvalidToken, err)
		}
		if t.Subject == "" {
			return nil, fmt.Errorf("%w: no sub claim", mcpauth.ErrInvalidToken)
		}
		var claims struct {
			Scope string `json:"scope"`
			Email string `json:"email"`
		}
		_ = t.Claims(&claims)
		info := &mcpauth.TokenInfo{
			UserID:     t.Subject,
			Expiration: t.Expiry,
			Extra:      map[string]any{"email": claims.Email},
		}
		info.Scopes = strings.Fields(claims.Scope)
		return info, nil
	}, nil
}
