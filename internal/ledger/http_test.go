package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func testServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s := testStore(t)
	if e := s.Bootstrap("owner", "test-password-1234"); e != nil {
		t.Fatal(e)
	}
	app := NewServer(s, "http://ledger.test", t.TempDir())
	ts := httptest.NewServer(app.Handler())
	t.Cleanup(ts.Close)
	return app, ts
}
func request(t *testing.T, ts *httptest.Server, method, path string, body any, cookie *http.Cookie, origin, marker string) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	r, e := http.NewRequest(method, ts.URL+path, bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	r.Header.Set("Content-Type", "application/json")
	if marker != "" {
		r.Header.Set("X-Ledger-Request", marker)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	resp, e := ts.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}
func loginCookie(t *testing.T, ts *httptest.Server) *http.Cookie {
	t.Helper()
	r := request(t, ts, "POST", "/api/login", map[string]string{"username": "owner", "password": "test-password-1234"}, nil, "http://ledger.test", "1")
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("login %d %s", r.StatusCode, b)
	}
	c := r.Cookies()[0]
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.MaxAge != 90*86400 {
		t.Fatalf("bad cookie %+v", c)
	}
	return c
}
func TestAuthCSRFRevocationAndPassword(t *testing.T) {
	app, ts := testServer(t)
	if r := request(t, ts, "GET", "/api/me", nil, nil, "", ""); r.StatusCode != 401 {
		t.Fatal(r.StatusCode)
	}
	if r := request(t, ts, "POST", "/api/login", map[string]string{}, nil, "http://evil.test", "1"); r.StatusCode != 403 {
		t.Fatal("origin accepted")
	}
	if r := request(t, ts, "POST", "/api/login", map[string]string{}, nil, "", ""); r.StatusCode != 403 {
		t.Fatal("missing CSRF marker accepted")
	}
	c := loginCookie(t, ts)
	second := loginCookie(t, ts)
	r := request(t, ts, "POST", "/api/tokens", map[string]any{"name": "AI", "days": 30}, c, "", "1")
	var token map[string]string
	json.NewDecoder(r.Body).Decode(&token)
	if token["token"] == "" {
		t.Fatal("token missing")
	}
	var stored string
	app.Store.DB.QueryRow("SELECT hash FROM credentials WHERE id=?", token["id"]).Scan(&stored)
	if stored == token["token"] {
		t.Fatal("plaintext token stored")
	}
	if r = request(t, ts, "POST", "/api/revoke", map[string]string{"id": token["id"]}, c, "", "1"); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r = request(t, ts, "POST", "/api/password", map[string]string{"current": "test-password-1234", "password": "changed-password-1234"}, c, "", "1"); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r = request(t, ts, "GET", "/api/me", nil, second, "", ""); r.StatusCode != 401 {
		t.Fatal("old device retained access")
	}
}

type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.base.RoundTrip(r)
}
func TestMCPHTTPToolsAndRevocation(t *testing.T) {
	app, ts := testServer(t)
	raw, id, e := app.issue("token", "mcp test", 1)
	if e != nil {
		t.Fatal(e)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "integration", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	session, e := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: ts.URL + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport{raw, http.DefaultTransport}}, DisableStandaloneSSE: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	list, e := session.ListTools(ctx, nil)
	if e != nil || len(list.Tools) != len(Operations) {
		t.Fatalf("tool list %v %v", list, e)
	}
	cat := firstCategory(t, app.Store)
	result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: "entries_batch_add", Arguments: map[string]any{"request_id": "mcp-batch-123", "entries": []map[string]string{{"amount": "12.34", "category_id": cat}}}})
	if e != nil || result.IsError {
		t.Fatalf("MCP batch %v %#v", e, result)
	}
	result, e = session.CallTool(ctx, &mcp.CallToolParams{Name: "report", Arguments: map[string]any{}})
	if e != nil || result.IsError {
		t.Fatalf("MCP report %v %#v", e, result)
	}
	var n int
	app.Store.DB.QueryRow("SELECT count(*) FROM history WHERE source LIKE 'mcp%' AND action='entries_batch_add'").Scan(&n)
	if n != 1 {
		t.Fatal("MCP audit missing")
	}
	app.Store.DB.Exec("DELETE FROM credentials WHERE id=?", id)
	_, e = session.ListTools(ctx, nil)
	if e == nil {
		t.Fatal("revoked token accepted")
	}
}
func TestExpiredCredentialsAndLoginLimit(t *testing.T) {
	app, ts := testServer(t)
	c := loginCookie(t, ts)
	app.Store.DB.Exec("UPDATE credentials SET expires='2000-01-01T00:00:00Z'")
	if r := request(t, ts, "GET", "/api/me", nil, c, "", ""); r.StatusCode != 401 {
		t.Fatal("expired session accepted")
	}
	for i := 0; i < 11; i++ {
		r := request(t, ts, "POST", "/api/login", map[string]string{"username": "owner", "password": "wrong"}, nil, "", "1")
		if i == 10 && r.StatusCode != 429 {
			t.Fatal("login not rate limited")
		}
	}
}
