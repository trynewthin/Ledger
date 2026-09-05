package ledger

// Tool schemas describe the minimal input of each operation; REST and MCP share
// the same transaction and validation implementation.
func toolSchema(op string) map[string]any {
	str := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	number := map[string]any{"type": "integer", "minimum": 1}
	object := func(properties map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
	}
	amount := str("非负十进制金额字符串，最多两位小数。记账金额须大于零。")
	entry := map[string]any{"created_at": str("创建时间，由服务管理"), "id": str("记录 ID；修改时必填"), "version": number, "amount": amount, "currency": str("CNY（默认）、USD、EUR、HKD、GBP、JPY、AUD、CAD、SGD、CHF"), "cny_amount": str("手工折合人民币金额，留空表示待折算"), "kind": str("expense（默认）或 income"), "category_id": str("有效分类 ID，先调用 categories_list"), "date": str("YYYY-MM-DD，默认中国时区今天"), "merchant": str("商家，可选"), "note": str("备注，可选"), "status": str("查询返回的状态；写入时由服务管理")}
	asset := map[string]any{"id": str("资产 ID；更新时必填"), "version": number, "name": str("名称"), "kind": str("asset 或 liability"), "amount": amount, "currency": str("币种，默认 CNY"), "cny_amount": str("折合人民币金额，可选"), "date": str("余额日期 YYYY-MM-DD，默认今天"), "note": str("备注"), "archived": map[string]any{"type": "boolean"}}
	fields := map[string]any{"id": str("记录 ID"), "version": number, "reason": str("调整原因"), "request_id": str("调用方生成的唯一幂等键，8-200 字符。同一请求重试必须沿用原键与参数。"), "entry": object(entry, "amount", "category_id"), "entries": map[string]any{"type": "array", "minItems": 1, "maxItems": 200, "items": object(entry, "amount", "category_id")}, "asset": object(asset, "name", "kind", "amount"), "category": object(map[string]any{"id": str("修改时填写分类 ID"), "name": str("分类名称"), "parent_id": str("一级分类留空，二级填写父分类 ID"), "archived": map[string]any{"type": "boolean"}}, "name"), "from": str("起始日期 YYYY-MM-DD，含当天"), "to": str("结束日期 YYYY-MM-DD，含当天"), "category_id": str("按分类筛选，含子分类"), "search": str("搜索商家、备注或分类名称"), "status": str("active（默认）、void 或 all"), "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 200}, "offset": map[string]any{"type": "integer", "minimum": 0}}
	allowed := map[string][]string{"entries_list": {"from", "to", "category_id", "search", "status", "limit", "offset"}, "report": {"from", "to", "category_id", "search"}, "entries_add": {"entry", "request_id", "reason"}, "entries_batch_add": {"entries", "request_id", "reason"}, "entries_update": {"entry", "reason"}, "entries_void": {"id", "version", "reason"}, "entries_restore": {"id", "version", "reason"}, "history_list": {"id", "limit", "offset"}, "categories_save": {"category", "reason"}, "assets_save": {"asset", "reason"}}
	required := map[string][]string{"entries_add": {"entry", "request_id"}, "entries_batch_add": {"entries", "request_id"}, "entries_update": {"entry"}, "entries_void": {"id", "version", "reason"}, "entries_restore": {"id", "version"}, "history_list": {"id"}, "categories_save": {"category"}, "assets_save": {"asset"}}
	if op == "entries_update" {
		fields["entry"] = object(entry, "id", "version", "amount", "category_id", "date", "currency", "kind")
	}
	properties := map[string]any{}
	for _, name := range allowed[op] {
		properties[name] = fields[name]
	}
	req := required[op]
	if req == nil {
		req = []string{}
	}
	return object(properties, req...)
}
