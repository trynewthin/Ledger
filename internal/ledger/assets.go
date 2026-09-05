package ledger

import (
	"database/sql"
	"encoding/json"
	"sort"
)

type AssetPoint struct {
	Date        string `json:"date"`
	Assets      int64  `json:"assets"`
	Liabilities int64  `json:"liabilities"`
	Net         int64  `json:"net"`
	Pending     int    `json:"pending"`
}

func assetTimeline(tx *sql.Tx) ([]AssetPoint, error) {
	rows, e := tx.Query("SELECT after_data FROM history WHERE action='assets_save' ORDER BY id")
	if e != nil {
		return nil, e
	}
	changes := map[string][]Asset{}
	for rows.Next() {
		var b string
		var a Asset
		if e = rows.Scan(&b); e != nil {
			rows.Close()
			return nil, e
		}
		if e = json.Unmarshal([]byte(b), &a); e != nil {
			rows.Close()
			return nil, e
		}
		changes[a.Date] = append(changes[a.Date], a)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	dates := []string{}
	for d := range changes {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	current := map[string]Asset{}
	points := []AssetPoint{}
	for _, d := range dates {
		for _, a := range changes[d] {
			current[a.ID] = a
		}
		p := AssetPoint{Date: d}
		for _, a := range current {
			if a.Archived {
				continue
			}
			n, ok := normalizedAmount(a.Amount, a.Currency, a.CNYAmount)
			if !ok {
				p.Pending++
				continue
			}
			if a.Kind == "asset" {
				p.Assets += n
			} else {
				p.Liabilities += n
			}
		}
		p.Net = p.Assets - p.Liabilities
		points = append(points, p)
	}
	return points, nil
}
