package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
)

// ErrNewerFormat is returned when a file's event log was written in a format
// this build does not know. Opening it anyway could misread or damage it.
var ErrNewerFormat = errors.New("written by a newer version of ziwo")

// migrations[v] rewrites a log from format v to format v+1. Each runs once,
// inside the transaction that lifts the append-only triggers.
var migrations = []func(context.Context, *sql.Tx) error{
	// 0 -> 1: reading a memory in full becomes its own kind of event.
	func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`UPDATE events SET kind = 'expand', payload = json_remove(payload, '$.query')
			  WHERE kind = 'recall' AND COALESCE(json_extract(payload, '$.query'), '') = ''`)
		return err
	},
}

// upgradeLog brings the event log to the current format. It reports whether
// it changed anything, in which case the derived tables are stale.
func (s *Store) upgradeLog(ctx context.Context) (migrated bool, err error) {
	err = s.write(ctx, func(tx *sql.Tx) error {
		have, set, err := getMeta(ctx, tx, metaLogFormat)
		if err != nil {
			return err
		}
		format := 0 // a log with events and no recorded format predates versioning
		if set {
			if format, err = strconv.Atoi(have); err != nil {
				return fmt.Errorf("unreadable log format %q", have)
			}
		} else {
			var events int64
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM events`).Scan(&events); err != nil {
				return err
			}
			if events == 0 {
				return setMeta(ctx, tx, metaLogFormat, strconv.Itoa(logFormat))
			}
		}
		switch {
		case format > logFormat:
			return fmt.Errorf("%w: its log format is %d, this build reads up to %d", ErrNewerFormat, format, logFormat)
		case format == logFormat:
			return nil
		}

		if _, err := tx.ExecContext(ctx, dropAppendOnlyTriggers); err != nil {
			return err
		}
		for ; format < logFormat; format++ {
			if err := migrations[format](ctx, tx); err != nil {
				return fmt.Errorf("upgrade log format %d to %d: %w", format, format+1, err)
			}
		}
		if _, err := tx.ExecContext(ctx, appendOnlyTriggers); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM meta WHERE key = ?`, metaDerived); err != nil {
			return err
		}
		migrated = true
		return setMeta(ctx, tx, metaLogFormat, strconv.Itoa(logFormat))
	})
	return migrated, err
}

// Keys of the meta table.
const (
	metaLogFormat = "log_format"
	metaDerived   = "derived"
	metaTokenHash = "token_sha256"
)

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func getMeta(ctx context.Context, q querier, key string) (value string, ok bool, err error) {
	err = q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return value, err == nil, err
}

func setMeta(ctx context.Context, e execer, key, value string) error {
	_, err := e.ExecContext(ctx,
		`INSERT INTO meta(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
