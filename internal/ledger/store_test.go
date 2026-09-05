package ledger

import (
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "ledger.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.DB.Close() })
	return s
}
func call[T any](t *testing.T, s *Store, op string, in Input) T {
	t.Helper()
	v, e := s.Invoke(op, in, "test")
	if e != nil {
		t.Fatalf("%s: %v", op, e)
	}
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	var out T
	if e = json.Unmarshal(b, &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func firstCategory(t *testing.T, s *Store) string {
	for _, c := range call[[]Category](t, s, "categories_list", Input{}) {
		if c.ParentID != "" {
			return c.ID
		}
	}
	t.Fatal("missing category")
	return ""
}
func TestMoney(t *testing.T) {
	for _, v := range []struct {
		s string
		n int64
	}{{"0.10", 10}, {"123456789.99", 12345678999}, {"1.2", 120}, {"0", 0}} {
		n, e := Cents(v.s)
		if e != nil || n != v.n {
			t.Fatalf("%s: %d %v", v.s, n, e)
		}
	}
	for _, v := range []string{"-1", "NaN", "1e2", ".2", "1.001", "01", "9999999999999"} {
		if _, e := Cents(v); e == nil {
			t.Fatalf("accepted %s", v)
		}
	}
}
func TestBatchAtomicIdempotentAndConcurrent(t *testing.T) {
	s := testStore(t)
	cat := firstCategory(t, s)
	good := Entry{Amount: "0.10", CategoryID: cat}
	bad := Entry{Amount: "4", CategoryID: "missing"}
	if _, e := s.Invoke("entries_batch_add", Input{RequestID: "bad-batch-1", Entries: []Entry{good, bad}}, "test"); e == nil {
		t.Fatal("invalid batch succeeded")
	}
	var n int
	s.DB.QueryRow("SELECT count(*) FROM objects WHERE kind='entry'").Scan(&n)
	if n != 0 {
		t.Fatal("partial batch persisted")
	}
	in := Input{RequestID: "unique-batch-1", Entries: []Entry{good, good}}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Go(func() { _, e := s.Invoke("entries_batch_add", in, "test"); errs <- e })
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	s.DB.QueryRow("SELECT count(*) FROM objects WHERE kind='entry'").Scan(&n)
	if n != 2 {
		t.Fatalf("dedup failed: %d", n)
	}
	in.Entries = []Entry{good}
	if _, e := s.Invoke("entries_batch_add", in, "test"); e == nil {
		t.Fatal("idempotency key allowed different payload")
	}
	s.DB.QueryRow("SELECT count(*) FROM history WHERE action='entries_batch_add'").Scan(&n)
	if n != 2 {
		t.Fatalf("unexpected history %d", n)
	}
}
func TestLifecycleReportsAndHistory(t *testing.T) {
	s := testStore(t)
	cat := firstCategory(t, s)
	v := call[Entry](t, s, "entries_add", Input{RequestID: "lifecycle-1", Entry: &Entry{Amount: "0.10", CategoryID: cat, Date: "2026-09-05"}})
	v.Amount = "0.20"
	updated := call[Entry](t, s, "entries_update", Input{Entry: &v, Reason: "修正"})
	if updated.Version != 2 {
		t.Fatal("missing version increment")
	}
	if _, e := s.Invoke("entries_update", Input{Entry: &v}, "test"); e != ErrConflict {
		t.Fatalf("expected conflict, got %v", e)
	}
	if _, e := s.Invoke("entries_void", Input{ID: v.ID, Version: 2}, "test"); e == nil {
		t.Fatal("void without reason")
	}
	_ = call[Entry](t, s, "entries_add", Input{RequestID: "foreign-1", Entry: &Entry{Amount: "5.00", CategoryID: cat, Currency: "USD", Date: v.Date}})
	type Report struct {
		Expense int64            `json:"expense"`
		Pending map[string]int64 `json:"pending"`
	}
	r := call[Report](t, s, "report", Input{From: v.Date, To: v.Date})
	if r.Expense != 20 || r.Pending["expense:USD"] != 500 {
		t.Fatalf("bad report %+v", r)
	}
	call[Entry](t, s, "entries_void", Input{ID: v.ID, Version: 2, Reason: "重复"})
	r = call[Report](t, s, "report", Input{})
	if r.Expense != 0 {
		t.Fatal("void included in report")
	}
	restored := call[Entry](t, s, "entries_restore", Input{ID: v.ID, Version: 3})
	if restored.Status != "active" {
		t.Fatal("restore failed")
	}
	h := call[[]History](t, s, "history_list", Input{ID: v.ID})
	if len(h) != 4 || h[1].Reason != "重复" || h[2].Reason != "修正" {
		t.Fatalf("history incomplete %+v", h)
	}
}
func TestCategoryDepthArchiveAndAssets(t *testing.T) {
	s := testStore(t)
	cat := firstCategory(t, s)
	if _, e := s.Invoke("categories_save", Input{Category: &Category{Name: "三级", ParentID: cat}}, "test"); e == nil {
		t.Fatal("allowed third level")
	}
	cats := call[[]Category](t, s, "categories_list", Input{})
	var parent Category
	for _, c := range cats {
		if c.ID == cat {
			for _, p := range cats {
				if p.ID == c.ParentID {
					parent = p
				}
			}
		}
	}
	parent.Archived = true
	call[Category](t, s, "categories_save", Input{Category: &parent})
	if _, e := s.Invoke("entries_add", Input{RequestID: "archived-1", Entry: &Entry{Amount: "1", CategoryID: cat}}, "test"); e == nil {
		t.Fatal("allowed archived parent")
	}
	a := call[Asset](t, s, "assets_save", Input{Asset: &Asset{Name: "储蓄", Kind: "asset", Amount: "1200", Date: "2026-09-05"}})
	a.Amount = "1300"
	a = call[Asset](t, s, "assets_save", Input{Asset: &a})
	h := call[[]History](t, s, "history_list", Input{ID: a.ID})
	if len(h) != 2 {
		t.Fatal("missing snapshots")
	}
	a.Date = "2026-09-01"
	if _, e := s.Invoke("assets_save", Input{Asset: &a}, "test"); e == nil {
		t.Fatal("backdated current balance")
	}
}
func TestPersistenceAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	s, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	cat := firstCategory(t, s)
	in := Input{RequestID: "persistent-key", Entry: &Entry{Amount: "3.14", CategoryID: cat}}
	a := call[Entry](t, s, "entries_add", in)
	s.DB.Close()
	s, e = Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	b := call[Entry](t, s, "entries_add", in)
	if a.ID != b.ID {
		t.Fatal("dedup did not survive restart")
	}
}

func TestAssetTimelineCarriesBalancesForward(t *testing.T) {
	s := testStore(t)
	a := call[Asset](t, s, "assets_save", Input{Asset: &Asset{Name: "现金", Amount: "100", Kind: "asset", Date: "2026-09-01"}})
	call[Asset](t, s, "assets_save", Input{Asset: &Asset{Name: "信用卡", Amount: "30", Kind: "liability", Date: "2026-09-02"}})
	a.Date = "2026-09-03"
	a.Amount = "150"
	call[Asset](t, s, "assets_save", Input{Asset: &a})
	points := call[[]AssetPoint](t, s, "assets_timeline", Input{})
	if len(points) != 3 || points[0].Net != 10000 || points[1].Net != 7000 || points[2].Net != 12000 {
		t.Fatalf("bad timeline %+v", points)
	}
}

func TestCurrencyValidationAndRecentOrdering(t *testing.T) {
	if e := money("1", "CNY|USD", "", true); e == nil {
		t.Fatal("composite currency accepted")
	}
	s := testStore(t)
	cat := firstCategory(t, s)
	a := call[Entry](t, s, "entries_add", Input{RequestID: "recent-first", Entry: &Entry{Amount: "1", CategoryID: cat}})
	b := call[Entry](t, s, "entries_add", Input{RequestID: "recent-second", Entry: &Entry{Amount: "2", CategoryID: cat}})
	list := call[struct {
		Items []Entry `json:"items"`
	}](t, s, "entries_list", Input{})
	if len(list.Items) != 2 || list.Items[0].ID != b.ID || a.CreatedAt == "" {
		t.Fatal("entries not sorted by creation")
	}
}
