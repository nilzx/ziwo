package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func metaValue(t *testing.T, path, key string) (string, bool) {
	t.Helper()
	raw, err := sql.Open("sqlite3", fileURI(path))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	v, ok, err := getMeta(context.Background(), raw, key)
	if err != nil {
		t.Fatal(err)
	}
	return v, ok
}

func rawExec(t *testing.T, path, stmt string) {
	t.Helper()
	raw, err := sql.Open("sqlite3", fileURI(path))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.Exec(stmt); err != nil {
		t.Fatalf("%s: %v", stmt, err)
	}
}

func TestNewFileRecordsItsLogFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	open(t, path).Close()
	if v, ok := metaValue(t, path, metaLogFormat); !ok || v != "1" {
		t.Errorf("log format = %q, %v; want 1", v, ok)
	}
}

func TestLogFromBeforeVersioningIsUpgraded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	s := open(t, path)
	sess := session(t, s, t0, "model-a", "cli")
	id := remember(t, s, t0, sess.ID, "用户给我看了他的猫", "一只橘猫。")
	fill(t, s, sess.ID, 5)
	listed(t, s, id)
	fill(t, s, sess.ID, 5)
	read(t, s, id)
	want := dump(t, s)
	wantStrength := get(t, s, id).Strength
	s.Close()

	// Turn the file into what a build from before versioning wrote: no
	// recorded format, and the reading logged as a recall without a query.
	rawExec(t, path, `DROP TRIGGER events_no_update;
		UPDATE events SET kind = 'recall' WHERE kind = 'expand';
		DELETE FROM meta WHERE key IN ('log_format', 'derived');`)

	s2 := open(t, path)
	if got := dump(t, s2); got != want {
		t.Errorf("upgraded store differs\nwant:\n%s\ngot:\n%s", want, got)
	}
	if got := get(t, s2, id).Strength; !near(got, wantStrength, 1e-9) || !(got > 10) {
		t.Errorf("strength after the upgrade = %v, want %v: the old reading must still count as a reading", got, wantStrength)
	}
	var expands, queryless int
	if err := s2.r.QueryRow(`SELECT count(*) FILTER (WHERE kind = 'expand'),
		count(*) FILTER (WHERE kind = 'recall' AND json_extract(payload, '$.query') IS NULL) FROM events`).Scan(&expands, &queryless); err != nil {
		t.Fatal(err)
	}
	if expands != 1 || queryless != 0 {
		t.Errorf("after the upgrade: %d expand events, %d recalls without a query; want 1, 0", expands, queryless)
	}
	if _, err := s2.w.Exec(`UPDATE events SET payload = '{}'`); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Errorf("the upgrade left the log writable: %v", err)
	}
	s2.Close()
	if v, _ := metaValue(t, path, metaLogFormat); v != "1" {
		t.Errorf("log format after the upgrade = %q, want 1", v)
	}
}

func TestLogFromANewerVersionIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	s := open(t, path)
	sess := session(t, s, t0, "", "cli")
	remember(t, s, t0, sess.ID, "一件事", "正文")
	s.Close()
	rawExec(t, path, `UPDATE meta SET value = '99' WHERE key = 'log_format'`)

	for name, opt := range map[string]Options{
		"full":     {Params: testParams()},
		"log only": {LogOnly: true},
	} {
		if s, err := Open(context.Background(), path, opt); !errors.Is(err, ErrNewerFormat) {
			if err == nil {
				s.Close()
			}
			t.Errorf("%s: err = %v, want %v", name, err, ErrNewerFormat)
		}
	}
	if v, _ := metaValue(t, path, metaLogFormat); v != "99" {
		t.Errorf("a refused open changed the recorded format to %q", v)
	}
	var events int
	raw, _ := sql.Open("sqlite3", fileURI(path))
	defer raw.Close()
	if err := raw.QueryRow(`SELECT count(*) FROM events`).Scan(&events); err != nil || events != 2 {
		t.Errorf("events after a refused open = %d (err %v), want 2", events, err)
	}
}
