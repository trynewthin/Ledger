package ledger

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

var Operations = map[string]string{
	"assets_timeline":   "查询按余额日期重建的资产、负债和净资产变化。金额单位为人民币分；同日使用最后一次快照，pending 为未折算项目数量。",
	"entries_list":      "查询收支记录。支持 from/to 日期（含边界）、category_id（含子分类）、search、status(active/void/all)、limit(1-200)、offset。",
	"entries_add":       "新增一笔收支。entry 必须包含 amount（十进制字符串）、category_id；date 默认中国时区今天，currency 默认 CNY，kind 默认 expense。可填 cny_amount、merchant、note。request_id 必填，重试必须沿用相同键和参数。",
	"entries_batch_add": "原子批量新增 1-200 笔收支。entries 数组字段同 entries_add。request_id 必填，相同请求重试不会重复入账。",
	"entries_update":    "编辑账目：entry 需包含完整账目及当前 id/version（先查询），reason 可选。保留历史；废止记录须先恢复。",
	"entries_void":      "废止账目：id、version、reason 必填；退出统计且保留历史。",
	"entries_restore":   "恢复废止账目：id、version 必填，reason 可选。",
	"history_list":      "按 id 查询账目、分类或资产的历史，支持 limit/offset。",
	"categories_list":   "列出所有两级分类，包括已归档分类。",
	"categories_save":   "新增或修改分类，category 包含 name、parent_id（一级留空）、archived；修改传 id。可归档，不能改变已有分类层级。",
	"assets_list":       "列出资产和负债的最新余额，独立于日常收支。",
	"assets_save":       "新增资产或负债，或更新余额快照。asset 包含 name、kind(asset/liability)、amount、currency、date、可选 cny_amount/note/archived；修改时传 id/version。每次保存保留历史。",
	"report":            "汇总 from/to（含边界）内有效收支，返回人民币分单位总额、每日趋势、分类支出和未折算外币。支持 category_id/search。",
}

func (s *Store) Invoke(op string, in Input, source string) (any, error) {
	if _, ok := Operations[op]; !ok {
		return nil, errors.New("未知操作")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	var result any
	switch op {
	case "categories_list":
		result, e = all[Category](tx, "category")
	case "categories_save":
		if in.Category == nil {
			return nil, errors.New("缺少 category")
		}
		v := *in.Category
		v.Name = strings.TrimSpace(v.Name)
		if v.Name == "" || len(v.Name) > 100 {
			return nil, errors.New("分类名称不能为空且不超过 100 字节")
		}
		var before any
		if v.ID != "" {
			old, er := get[Category](tx, "category", v.ID)
			if er != nil {
				return nil, er
			}
			if old.ParentID != v.ParentID {
				return nil, errors.New("已有分类不能改变层级")
			}
			before = old
		} else {
			v.ID = ID()
		}
		if v.ParentID != "" {
			p, er := get[Category](tx, "category", v.ParentID)
			if er != nil || p.ParentID != "" || p.ID == v.ID || p.Archived {
				return nil, errors.New("父分类须为有效的一级分类")
			}
		}
		cats, er := all[Category](tx, "category")
		if er != nil {
			return nil, er
		}
		for _, c := range cats {
			if c.ID != v.ID && c.ParentID == v.ParentID && c.Name == v.Name {
				return nil, errors.New("同级分类名称重复")
			}
		}
		e = put(tx, "category", v.ID, v)
		if e == nil {
			e = audit(tx, v.ID, op, source, in.Reason, before, v)
		}
		result = v
	case "entries_add", "entries_batch_add":
		if len(in.RequestID) < 8 || len(in.RequestID) > 200 {
			return nil, errors.New("request_id 须为 8-200 字符的唯一请求标识")
		}
		req, _ := json.Marshal(struct {
			Op    string
			Input Input
		}{op, in})
		var oldReq, oldResp string
		er := tx.QueryRow("SELECT request,response FROM idempotency WHERE key=?", in.RequestID).Scan(&oldReq, &oldResp)
		if er != nil && !errors.Is(er, sql.ErrNoRows) {
			return nil, er
		}
		if er == nil {
			if oldReq != string(req) {
				return nil, errors.New("此 request_id 已用于不同内容")
			}
			var v any
			e = json.Unmarshal([]byte(oldResp), &v)
			return v, e
		}
		items := in.Entries
		if op == "entries_add" {
			if in.Entry == nil {
				return nil, errors.New("缺少 entry")
			}
			items = []Entry{*in.Entry}
		}
		if len(items) == 0 || len(items) > 200 {
			return nil, errors.New("每批须包含 1-200 笔记录")
		}
		out := []Entry{}
		for i, v := range items {
			v.ID = ID()
			v.CreatedAt = Now()
			v.Version = 1
			v.Status = "active"
			if er := validateEntry(tx, &v); er != nil {
				return nil, fail("第 %d 笔：%v", i+1, er)
			}
			if e = put(tx, "entry", v.ID, v); e != nil {
				return nil, e
			}
			if e = audit(tx, v.ID, op, source, in.Reason, nil, v); e != nil {
				return nil, e
			}
			out = append(out, v)
		}
		result = out
		if op == "entries_add" {
			result = out[0]
		}
		b, _ := json.Marshal(result)
		_, e = tx.Exec("INSERT INTO idempotency(key,request,response) VALUES(?,?,?)", in.RequestID, string(req), string(b))
	case "entries_update", "entries_void", "entries_restore":
		id, version := in.ID, in.Version
		if op == "entries_update" {
			if in.Entry == nil {
				return nil, errors.New("缺少 entry")
			}
			id = in.Entry.ID
			version = in.Entry.Version
		}
		old, er := get[Entry](tx, "entry", id)
		if er != nil {
			return nil, er
		}
		if old.Version != version {
			return nil, ErrConflict
		}
		v := old
		if op == "entries_update" {
			if old.Status != "active" {
				return nil, errors.New("请先恢复废止记录")
			}
			v = *in.Entry
			v.Status = old.Status
			v.CreatedAt = old.CreatedAt
			if er = validateEntry(tx, &v); er != nil {
				return nil, er
			}
		}
		if op == "entries_void" {
			if strings.TrimSpace(in.Reason) == "" {
				return nil, errors.New("废止必须填写原因")
			}
			if old.Status == "void" {
				return nil, errors.New("记录已废止")
			}
			v.Status = "void"
		}
		if op == "entries_restore" {
			if old.Status != "void" {
				return nil, errors.New("记录未废止")
			}
			v.Status = "active"
		}
		v.Version = old.Version + 1
		e = put(tx, "entry", v.ID, v)
		if e == nil {
			e = audit(tx, v.ID, op, source, in.Reason, old, v)
		}
		result = v
	case "entries_list", "report":
		if in.Status != "" && in.Status != "active" && in.Status != "void" && in.Status != "all" {
			return nil, errors.New("无效的记录状态")
		}
		if in.From != "" {
			if e = date(in.From); e != nil {
				return nil, e
			}
		}
		if in.To != "" {
			if e = date(in.To); e != nil {
				return nil, e
			}
		}
		if in.From != "" && in.To != "" && in.From > in.To {
			return nil, errors.New("起始日期不能晚于结束日期")
		}
		entries, er := all[Entry](tx, "entry")
		if er != nil {
			return nil, er
		}
		cats, er := all[Category](tx, "category")
		if er != nil {
			return nil, er
		}
		allowed := map[string]bool{in.CategoryID: true}
		names := map[string]string{}
		for _, c := range cats {
			names[c.ID] = c.Name
			if c.ParentID == in.CategoryID {
				allowed[c.ID] = true
			}
		}
		filtered := []Entry{}
		for _, v := range entries {
			if in.From != "" && v.Date < in.From || in.To != "" && v.Date > in.To {
				continue
			}
			if in.CategoryID != "" && !allowed[v.CategoryID] {
				continue
			}
			if in.Search != "" && !strings.Contains(strings.ToLower(v.Merchant+" "+v.Note+" "+names[v.CategoryID]), strings.ToLower(in.Search)) {
				continue
			}
			status := in.Status
			if status == "" || op == "report" {
				status = "active"
			}
			if status != "all" && v.Status != status {
				continue
			}
			filtered = append(filtered, v)
		}
		sort.Slice(filtered, func(i, j int) bool {
			if filtered[i].Date == filtered[j].Date {
				if filtered[i].CreatedAt != filtered[j].CreatedAt {
					return filtered[i].CreatedAt > filtered[j].CreatedAt
				}
				return filtered[i].ID > filtered[j].ID
			}
			return filtered[i].Date > filtered[j].Date
		})
		if op == "entries_list" {
			n := len(filtered)
			limit := in.Limit
			if limit <= 0 || limit > 200 {
				limit = 50
			}
			offset := max(0, min(in.Offset, n))
			result = map[string]any{"items": filtered[offset:min(offset+limit, n)], "total": n}
		} else {
			var expense, income int64
			pending := map[string]int64{}
			daily := map[string]int64{}
			byCategory := map[string]int64{}
			for _, v := range filtered {
				n, ok := normalizedAmount(v.Amount, v.Currency, v.CNYAmount)
				if !ok {
					a, _ := Cents(v.Amount)
					pending[v.Kind+":"+v.Currency] += a
					continue
				}
				if v.Kind == "expense" {
					expense += n
					daily[v.Date] += n
					byCategory[v.CategoryID] += n
				} else {
					income += n
				}
			}
			result = map[string]any{"expense": expense, "income": income, "count": len(filtered), "daily": daily, "categories": byCategory, "pending": pending}
		}
	case "history_list":
		limit := in.Limit
		if limit <= 0 || limit > 200 {
			limit = 100
		}
		rows, er := tx.Query("SELECT id,entity_id,action,source,reason,at,before_data,after_data FROM history WHERE entity_id=? ORDER BY id DESC LIMIT ? OFFSET ?", in.ID, limit, max(in.Offset, 0))
		if er != nil {
			return nil, er
		}
		out := []History{}
		for rows.Next() {
			var h History
			var b, a string
			if er = rows.Scan(&h.ID, &h.EntityID, &h.Action, &h.Source, &h.Reason, &h.At, &b, &a); er != nil {
				rows.Close()
				return nil, er
			}
			h.Before = json.RawMessage(b)
			h.After = json.RawMessage(a)
			out = append(out, h)
		}
		e = rows.Err()
		rows.Close()
		result = out
	case "assets_timeline":
		result, e = assetTimeline(tx)
	case "assets_list":
		result, e = all[Asset](tx, "asset")
	case "assets_save":
		if in.Asset == nil {
			return nil, errors.New("缺少 asset")
		}
		v := *in.Asset
		v.Name = strings.TrimSpace(v.Name)
		if v.Name == "" || len(v.Name) > 200 {
			return nil, errors.New("请填写资产名称（不超过 200 字节）")
		}
		if v.Kind != "asset" && v.Kind != "liability" {
			return nil, errors.New("类型须为 asset 或 liability")
		}
		if v.Currency == "" {
			v.Currency = "CNY"
		}
		if v.Date == "" {
			v.Date = Today()
		}
		if e = money(v.Amount, v.Currency, v.CNYAmount, false); e != nil {
			return nil, e
		}
		if e = date(v.Date); e != nil {
			return nil, e
		}
		if v.Currency == "CNY" {
			v.CNYAmount = v.Amount
		}
		var before any
		if v.ID != "" {
			old, er := get[Asset](tx, "asset", v.ID)
			if er != nil {
				return nil, er
			}
			if old.Version != v.Version {
				return nil, ErrConflict
			}
			if v.Date < old.Date {
				return nil, errors.New("余额日期不能早于当前快照日期")
			}
			before = old
			v.Version++
		} else {
			v.ID = ID()
			v.Version = 1
		}
		e = put(tx, "asset", v.ID, v)
		if e == nil {
			e = audit(tx, v.ID, op, source, in.Reason, before, v)
		}
		result = v
	}
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return result, nil
}
