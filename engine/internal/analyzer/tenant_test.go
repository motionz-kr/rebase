package analyzer

import "testing"

func TestReferencesColumn(t *testing.T) {
	if !ReferencesColumn("hospitalId = 153 AND x=1", "hospitalId") {
		t.Error("should find hospitalId")
	}
	if ReferencesColumn("xhospitalIdy = 1", "hospitalId") {
		t.Error("must match whole word only")
	}
	if !ReferencesColumn("WHERE HOSPITALID=1", "hospitalId") {
		t.Error("case-insensitive match expected")
	}
}

func TestApplyTenantCheck(t *testing.T) {
	r := Analyze("UPDATE patients SET x=1 WHERE id=2", []string{"hospitalId"})
	r = ApplyTenantCheck(r, []string{"id", "hospitalId", "x"}, []string{"hospitalId"}, true)
	if !r.TenantMissing {
		t.Fatal("expected TenantMissing=true")
	}
	if r.Level != RiskHigh {
		t.Errorf("safe-mode tenant-missing should be high, got %q", r.Level)
	}

	r2 := Analyze("UPDATE patients SET x=1 WHERE hospitalId=9", []string{"hospitalId"})
	r2 = ApplyTenantCheck(r2, []string{"id", "hospitalId", "x"}, []string{"hospitalId"}, true)
	if r2.TenantMissing {
		t.Error("expected TenantMissing=false when referenced")
	}

	r3 := Analyze("UPDATE lookup SET x=1 WHERE id=2", []string{"hospitalId"})
	r3 = ApplyTenantCheck(r3, []string{"id", "x"}, []string{}, true)
	if r3.TenantMissing {
		t.Error("no tenant column on table -> not missing")
	}
}

func TestIntersectColumns(t *testing.T) {
	got := IntersectColumns([]string{"id", "HospitalId", "name"}, []string{"hospitalId", "tenantId"})
	if len(got) != 1 || got[0] != "hospitalId" {
		t.Errorf("expected [hospitalId] (configured spelling), got %v", got)
	}
}
