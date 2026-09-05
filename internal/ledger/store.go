package ledger

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Store struct{ DB *sql.DB }
type Category struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parent_id"`
	Archived bool   `json:"archived"`
}
type Entry struct {
	CreatedAt  string `json:"created_at"`
	ID         string `json:"id"`
	Version    int    `json:"version"`
	Amount     string `json:"amount"`
	Currency   string `json:"currency"`
	CNYAmount  string `json:"cny_amount"`
	Kind       string `json:"kind"`
	CategoryID string `json:"category_id"`
	Date       string `json:"date"`
	Merchant   string `json:"merchant"`
	Note       string `json:"note"`
	Status     string `json:"status"`
}
type Asset struct {
	ID        string `json:"id"`
	Version   int    `json:"version"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Amount    string `json:"amount"`
	Currency  string `json:"currency"`
	CNYAmount string `json:"cny_amount"`
	Date      string `json:"date"`
	Note      string `json:"note"`
	Archived  bool   `json:"archived"`
}
type History struct {
	ID       int64           `json:"id"`
	EntityID string          `json:"entity_id"`
	Action   string          `json:"action"`
	Source   string          `json:"source"`
	Reason   string          `json:"reason"`
	At       string          `json:"at"`
	Before   json.RawMessage `json:"before"`
	After    json.RawMessage `json:"after"`
}
type Input struct {
	ID         string    `json:"id,omitempty"`
	Version    int       `json:"version,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	RequestID  string    `json:"request_id,omitempty"`
	Entry      *Entry    `json:"entry,omitempty"`
	Entries    []Entry   `json:"entries,omitempty"`
	Category   *Category `json:"category,omitempty"`
	Asset      *Asset    `json:"asset,omitempty"`
	From       string    `json:"from,omitempty"`
	To         string    `json:"to,omitempty"`
	CategoryID string    `json:"category_id,omitempty"`
	Search     string    `json:"search,omitempty"`
	Status     string    `json:"status,omitempty"`
	Limit      int       `json:"limit,omitempty"`
	Offset     int       `json:"offset,omitempty"`
}

var ErrConflict = errors.New("记录已被修改，请刷新后重试")

func ID() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func Now() string   { return time.Now().UTC().Format(time.RFC3339Nano) }
func Today() string { return time.Now().In(time.FixedZone("CST", 8*3600)).Format("2006-01-02") }
func Open(path string) (*Store, error) {
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS history_entity ON history(entity_id,id);
 CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL, last_used TEXT NOT NULL, expires TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS objects_kind ON objects(kind);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	s := &Store{db}
	var count int
	e = db.QueryRow("SELECT count(*) FROM objects WHERE kind='category'").Scan(&count)
	if e != nil {
		return nil, e
	}
	if count == 0 {
		tx, e := db.Begin()
		if e != nil {
			return nil, e
		}
		defer tx.Rollback()
		for _, group := range [][]string{{"餐饮", "正餐", "咖啡饮品", "零食"}, {"交通", "公共交通", "打车"}, {"生活", "日用品", "住房", "医疗"}, {"购物", "服饰", "数码"}, {"娱乐", "订阅", "旅行"}, {"收入", "工资", "其他收入"}} {
			p := ID()
			if e = put(tx, "category", p, Category{ID: p, Name: group[0]}); e != nil {
				return nil, e
			}
			for _, name := range group[1:] {
				id := ID()
				if e = put(tx, "category", id, Category{ID: id, Name: name, ParentID: p}); e != nil {
					return nil, e
				}
			}
		}
		e = tx.Commit()
		if e != nil {
			return nil, e
		}
	}
	return s, nil
}
func put(tx *sql.Tx, kind, id string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	_, e = tx.Exec("INSERT INTO objects(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", id, kind, string(b))
	return e
}
func get[T any](tx *sql.Tx, kind, id string) (T, error) {
	var v T
	var b string
	e := tx.QueryRow("SELECT data FROM objects WHERE id=? AND kind=?", id, kind).Scan(&b)
	if errors.Is(e, sql.ErrNoRows) {
		return v, errors.New("记录不存在")
	}
	if e != nil {
		return v, e
	}
	e = json.Unmarshal([]byte(b), &v)
	return v, e
}
func all[T any](tx *sql.Tx, kind string) ([]T, error) {
	rows, e := tx.Query("SELECT data FROM objects WHERE kind=? ORDER BY id", kind)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var b string
		var v T
		if e = rows.Scan(&b); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(b), &v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func audit(tx *sql.Tx, id, action, source, reason string, before, after any) error {
	b, _ := json.Marshal(before)
	a, _ := json.Marshal(after)
	_, e := tx.Exec("INSERT INTO history(entity_id,action,source,reason,at,before_data,after_data) VALUES(?,?,?,?,?,?,?)", id, action, source, reason, Now(), string(b), string(a))
	return e
}

var amountRE = regexp.MustCompile(`^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$`)

func Cents(s string) (int64, error) {
	if !amountRE.MatchString(s) {
		return 0, errors.New("金额须为非负数，最多两位小数、12 位整数")
	}
	p := strings.SplitN(s, ".", 2)
	n, _ := strconv.ParseInt(p[0], 10, 64)
	if len(p) == 2 {
		d := p[1] + "0"
		v, _ := strconv.ParseInt(d[:2], 10, 64)
		n = n*100 + v
	} else {
		n *= 100
	}
	return n, nil
}
func money(s, currency, cny string, positive bool) error {
	n, e := Cents(s)
	if e != nil {
		return e
	}
	if positive && n == 0 {
		return errors.New("记账金额须大于零")
	}
	if !map[string]bool{"CNY": true, "USD": true, "EUR": true, "HKD": true, "GBP": true, "JPY": true, "AUD": true, "CAD": true, "SGD": true, "CHF": true}[currency] {
		return errors.New("不支持的币种")
	}
	if currency == "JPY" && n%100 != 0 {
		return errors.New("日元金额须为整数")
	}
	if cny != "" {
		_, e = Cents(cny)
	}
	return e
}
func date(s string) error {
	_, e := time.Parse("2006-01-02", s)
	if e != nil {
		return errors.New("日期格式须为 YYYY-MM-DD")
	}
	return nil
}
func validateEntry(tx *sql.Tx, v *Entry) error {
	if v.Currency == "" {
		v.Currency = "CNY"
	}
	if v.Kind == "" {
		v.Kind = "expense"
	}
	if v.Date == "" {
		v.Date = Today()
	}
	if v.Kind != "expense" && v.Kind != "income" {
		return errors.New("无效的收支类型")
	}
	if e := money(v.Amount, v.Currency, v.CNYAmount, true); e != nil {
		return e
	}
	if v.Currency == "CNY" {
		v.CNYAmount = v.Amount
	}
	if e := date(v.Date); e != nil {
		return e
	}
	c, e := get[Category](tx, "category", v.CategoryID)
	if e != nil || c.Archived {
		return errors.New("请选择有效分类")
	}
	if c.ParentID != "" {
		p, e := get[Category](tx, "category", c.ParentID)
		if e != nil || p.Archived {
			return errors.New("父分类已归档")
		}
	}
	if len(v.Note) > 4000 || len(v.Merchant) > 200 {
		return errors.New("备注或商家名称过长")
	}
	return nil
}
func normalizedAmount(amount, currency, cny string) (int64, bool) {
	if currency == "CNY" {
		n, _ := Cents(amount)
		return n, true
	}
	if cny == "" {
		return 0, false
	}
	n, _ := Cents(cny)
	return n, true
}
func fail(format string, args ...any) error { return fmt.Errorf(format, args...) }
