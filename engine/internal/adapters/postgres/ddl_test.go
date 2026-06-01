package postgres

import "testing"

func TestBuildPostgresCreateTable(t *testing.T) {
	t.Run("columns with types, not-null, defaults, and a primary key", func(t *testing.T) {
		cols := []pgColumn{
			{Name: "id", Type: "integer", NotNull: true, Default: "nextval('products_id_seq'::regclass)"},
			{Name: "title", Type: "text", NotNull: true},
			{Name: "price", Type: "numeric"},
		}
		got := buildPostgresCreateTable("public", "products", cols, []string{"id"})
		want := `CREATE TABLE public.products (
    id integer NOT NULL DEFAULT nextval('products_id_seq'::regclass),
    title text NOT NULL,
    price numeric,
    PRIMARY KEY (id)
);`
		if got != want {
			t.Errorf("DDL mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
		}
	})

	t.Run("table without a primary key omits the constraint line", func(t *testing.T) {
		cols := []pgColumn{{Name: "a", Type: "text"}}
		got := buildPostgresCreateTable("public", "t", cols, nil)
		want := `CREATE TABLE public.t (
    a text
);`
		if got != want {
			t.Errorf("DDL mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
		}
	})

	t.Run("composite primary key lists columns in order", func(t *testing.T) {
		cols := []pgColumn{
			{Name: "order_id", Type: "integer", NotNull: true},
			{Name: "product_id", Type: "integer", NotNull: true},
		}
		got := buildPostgresCreateTable("shop", "order_items", cols, []string{"order_id", "product_id"})
		want := `CREATE TABLE shop.order_items (
    order_id integer NOT NULL,
    product_id integer NOT NULL,
    PRIMARY KEY (order_id, product_id)
);`
		if got != want {
			t.Errorf("DDL mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
		}
	})
}
