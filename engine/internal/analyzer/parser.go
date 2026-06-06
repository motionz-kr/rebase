package analyzer

type ParsedDML struct {
	Verb        string   `json:"verb"`
	Table       string   `json:"table"`
	WhereClause string   `json:"whereClause"`
	HasWhere    bool     `json:"hasWhere"`
	SetCols     []string `json:"setCols"`
	Parseable   bool     `json:"parseable"`
}

func ParseDML(query string) ParsedDML { return ParsedDML{} }
