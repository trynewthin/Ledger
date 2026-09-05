package ledger

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/time/rate"
)

type Server struct {
	Store   *Store
	Origin  string
	WebDir  string
	limiter *rate.Limiter
}
type credential struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Created  string `json:"created"`
	LastUsed string `json:"last_used"`
	Expires  string `json:"expires"`
	Current  bool   `json:"current"`
}
type ctxKey string

func hash(v string) string { b := sha256.Sum256([]byte(v)); return hex.EncodeToString(b[:]) }
func (s *Store) Bootstrap(username, password string) error {
	var n int
	if e := s.DB.QueryRow("SELECT count(*) FROM users").Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return nil
	}
	if username == "" || len(password) < 12 || len(password) > 72 {
		return errors.New("首次启动须设置 LEDGER_ADMIN_USER 和 12-72 字节的 LEDGER_ADMIN_PASSWORD（或 PASSWORD_FILE）")
	}
	b, e := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if e != nil {
		return e
	}
	_, e = s.DB.Exec("INSERT INTO users(username,password) VALUES(?,?)", username, b)
	return e
}
func NewServer(s *Store, origin, webDir string) *Server {
	return &Server{s, strings.TrimRight(origin, "/"), webDir, rate.NewLimiter(rate.Every(6*time.Second), 10)}
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func bad(w http.ResponseWriter, status int, e string) {
	respond(w, status, map[string]string{"error": e})
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return errors.New("请求 JSON 无效或含未知字段")
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return errors.New("请求只能包含一个 JSON 对象")
	}
	return nil
}
func (s *Server) authenticate(r *http.Request, kind string) (string, error) {
	var raw string
	if kind == "token" {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			return "", errors.New("缺少 Bearer Token")
		}
		raw = strings.TrimPrefix(h, "Bearer ")
	} else {
		c, e := r.Cookie("ledger_session")
		if e != nil {
			return "", e
		}
		raw = c.Value
	}
	var id, expires string
	e := s.Store.DB.QueryRow("SELECT id,expires FROM credentials WHERE hash=? AND kind=?", hash(raw), kind).Scan(&id, &expires)
	if e != nil {
		return "", errors.New("凭据无效")
	}
	t, e := time.Parse(time.RFC3339Nano, expires)
	if e != nil || time.Now().After(t) {
		return "", errors.New("凭据已过期")
	}
	_, e = s.Store.DB.Exec("UPDATE credentials SET last_used=? WHERE id=?", Now(), id)
	return id, e
}
func (s *Server) issue(kind, name string, days int) (string, string, error) {
	raw := ID() + ID()
	id := ID()
	expiry := time.Now().Add(time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	if days == 0 {
		expiry = "9999-12-31T00:00:00Z"
	}
	_, e := s.Store.DB.Exec("INSERT INTO credentials(id,hash,kind,name,created,last_used,expires) VALUES(?,?,?,?,?,?,?)", id, hash(raw), kind, name, Now(), Now(), expiry)
	return raw, id, e
}
func (s *Server) cookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: "ledger_session", Value: value, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(s.Origin, "https://"), SameSite: http.SameSiteStrictMode, MaxAge: age})
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if e := s.Store.DB.PingContext(r.Context()); e != nil {
			bad(w, 503, "unavailable")
			return
		}
		respond(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /api/login", s.login)
	mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, e := s.authenticate(r, "session")
		if e != nil {
			bad(w, 401, "请登录")
			return
		}
		s.api(w, r, id)
	}))
	ms := mcp.NewServer(&mcp.Implementation{Name: "ledger", Version: "1.0.0"}, nil)
	for name, desc := range Operations {
		op := name
		mcp.AddTool(ms, &mcp.Tool{Name: name, Description: desc, InputSchema: toolSchema(op)}, func(ctx context.Context, req *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
			source := "mcp"
			if id, ok := ctx.Value(ctxKey("token")).(string); ok {
				source += "/" + id
			}
			out, e := s.Store.Invoke(op, in, source)
			return nil, out, e
		})
	}
	mh := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server { return ms }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 2 << 20})
	mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, e := s.authenticate(r, "token")
		if e != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="ledger"`)
			bad(w, 401, "需要有效的 MCP Bearer Token")
			return
		}
		mh.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey("token"), id)))
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(405)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api") || strings.HasPrefix(r.URL.Path, "/mcp/") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(s.WebDir, filepath.FromSlash(strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")))
		st, e := os.Stat(path)
		if e == nil && !st.IsDir() {
			http.ServeFile(w, r, path)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(s.WebDir, "index.html"))
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		origin := r.Header.Get("Origin")
		if origin != "" {
			expected := s.Origin
			if expected == "" {
				expected = "http://" + r.Host
			}
			if origin != expected {
				bad(w, 403, "不允许跨站请求")
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != "GET" && r.Header.Get("X-Ledger-Request") != "1" {
			bad(w, 403, "缺少请求验证标记")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.Allow() {
		bad(w, 429, "尝试过于频繁，请稍后再试")
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if e := decode(r, &in); e != nil {
		bad(w, 400, e.Error())
		return
	}
	var name string
	var b []byte
	e := s.Store.DB.QueryRow("SELECT username,password FROM users LIMIT 1").Scan(&name, &b)
	if e != nil {
		bad(w, 503, "账号尚未初始化")
		return
	}
	check := bcrypt.CompareHashAndPassword(b, []byte(in.Password))
	if check != nil || in.Username != name {
		bad(w, 401, "账号或密码错误")
		return
	}
	raw, _, e := s.issue("session", r.UserAgent(), 90)
	if e != nil {
		bad(w, 500, "登录失败")
		return
	}
	s.cookie(w, raw, 90*86400)
	respond(w, 200, map[string]bool{"ok": true})
}
func (s *Server) api(w http.ResponseWriter, r *http.Request, current string) {
	path := strings.TrimPrefix(r.URL.Path, "/api/")
	if r.Method == "GET" && path == "me" {
		var name string
		if e := s.Store.DB.QueryRow("SELECT username FROM users LIMIT 1").Scan(&name); e != nil {
			bad(w, 500, "读取账号失败")
			return
		}
		respond(w, 200, map[string]string{"username": name})
		return
	}
	if r.Method == "GET" && (path == "tokens" || path == "sessions") {
		kind := "token"
		if path == "sessions" {
			kind = "session"
		}
		rows, e := s.Store.DB.Query("SELECT id,name,created,last_used,expires FROM credentials WHERE kind=? ORDER BY created DESC", kind)
		if e != nil {
			bad(w, 500, "读取失败")
			return
		}
		defer rows.Close()
		out := []credential{}
		for rows.Next() {
			var c credential
			if e = rows.Scan(&c.ID, &c.Name, &c.Created, &c.LastUsed, &c.Expires); e != nil {
				bad(w, 500, "读取失败")
				return
			}
			c.Current = c.ID == current
			out = append(out, c)
		}
		if rows.Err() != nil {
			bad(w, 500, "读取失败")
			return
		}
		respond(w, 200, out)
		return
	}
	if r.Method != "POST" {
		bad(w, 405, "不支持的请求方法")
		return
	}
	switch path {
	case "logout":
		_, e := s.Store.DB.Exec("DELETE FROM credentials WHERE id=?", current)
		if e != nil {
			bad(w, 500, "退出失败")
			return
		}
		s.cookie(w, "", -1)
		respond(w, 200, map[string]bool{"ok": true})
	case "tokens":
		var in struct {
			Name string `json:"name"`
			Days int    `json:"days"`
		}
		if e := decode(r, &in); e != nil {
			bad(w, 400, e.Error())
			return
		}
		if strings.TrimSpace(in.Name) == "" || len(in.Name) > 100 || in.Days < 0 || in.Days > 3650 {
			bad(w, 400, "请填写名称和有效期（0-3650 天，0 为长期有效）")
			return
		}
		raw, id, e := s.issue("token", in.Name, in.Days)
		if e != nil {
			bad(w, 500, "创建失败")
			return
		}
		respond(w, 201, map[string]string{"token": raw, "id": id})
	case "revoke":
		var in struct {
			ID string `json:"id"`
		}
		if e := decode(r, &in); e != nil {
			bad(w, 400, e.Error())
			return
		}
		if _, e := s.Store.DB.Exec("DELETE FROM credentials WHERE id=?", in.ID); e != nil {
			bad(w, 500, "撤销失败")
			return
		}
		respond(w, 200, map[string]bool{"ok": true})
	case "password":
		var in struct {
			Current  string `json:"current"`
			Password string `json:"password"`
		}
		if !s.limiter.Allow() {
			bad(w, 429, "尝试过于频繁")
			return
		}
		if e := decode(r, &in); e != nil {
			bad(w, 400, e.Error())
			return
		}
		var b []byte
		if e := s.Store.DB.QueryRow("SELECT password FROM users LIMIT 1").Scan(&b); e != nil {
			bad(w, 500, "读取失败")
			return
		}
		if bcrypt.CompareHashAndPassword(b, []byte(in.Current)) != nil {
			bad(w, 400, "当前密码错误")
			return
		}
		if len(in.Password) < 12 || len(in.Password) > 72 {
			bad(w, 400, "新密码须为 12-72 字节")
			return
		}
		b, e := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		if e != nil {
			bad(w, 500, "修改失败")
			return
		}
		tx, e := s.Store.DB.Begin()
		if e != nil {
			bad(w, 500, "修改失败")
			return
		}
		defer tx.Rollback()
		if _, e = tx.Exec("UPDATE users SET password=?", b); e == nil {
			_, e = tx.Exec("DELETE FROM credentials WHERE kind='session'")
		}
		if e == nil {
			e = tx.Commit()
		}
		if e != nil {
			bad(w, 500, "修改失败")
			return
		}
		s.cookie(w, "", -1)
		respond(w, 200, map[string]bool{"ok": true})
	default:
		if !strings.HasPrefix(path, "action/") {
			bad(w, 404, "接口不存在")
			return
		}
		var in Input
		if e := decode(r, &in); e != nil {
			bad(w, 400, e.Error())
			return
		}
		out, e := s.Store.Invoke(strings.TrimPrefix(path, "action/"), in, "web/"+current)
		if e != nil {
			status := 400
			if errors.Is(e, ErrConflict) {
				status = 409
			}
			bad(w, status, e.Error())
			return
		}
		respond(w, 200, out)
	}
}
func ValidateOrigin(origin string) error {
	if origin == "" {
		return nil
	}
	u, e := url.Parse(origin)
	if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return errors.New("LEDGER_ORIGIN 须为不含路径的 http(s) 地址")
	}
	return nil
}
