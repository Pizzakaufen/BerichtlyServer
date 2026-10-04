package store

import (
	"context"
	"time"

	"github.com/google/uuid"

	"berichtly-server/internal/model"
)

const userColumns = `id, email, password_hash, status, timezone, created_at,
	(locked_until IS NOT NULL AND locked_until > now()) AS locked`

func scanUser(row interface{ Scan(...any) error }) (*model.User, error) {
	var u model.User
	var status string
	if err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &status, &u.Timezone, &u.CreatedAt, &u.Locked); err != nil {
		return nil, err
	}
	u.Status = model.UserStatus(status)
	return &u, nil
}

func InsertUser(ctx context.Context, q Querier, id uuid.UUID, email, passwordHash, timezone string) error {
	_, err := q.Exec(ctx, `INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, $2, $3, $4)`,
		id, email, passwordHash, timezone)
	return err
}

// FindUserByEmail liefert nil, wenn kein Konto existiert.
func FindUserByEmail(ctx context.Context, q Querier, email string) (*model.User, error) {
	u, err := scanUser(q.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE email = $1`, email))
	if IsNoRows(err) {
		return nil, nil
	}
	return u, err
}

func FindUserByID(ctx context.Context, q Querier, id uuid.UUID) (*model.User, error) {
	u, err := scanUser(q.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
	if IsNoRows(err) {
		return nil, nil
	}
	return u, err
}

// RecordFailedLogin zählt einen Fehlversuch; beim Erreichen von maxAttempts wird das Konto
// vorübergehend gesperrt (Zeit aus der Datenbank).
func RecordFailedLogin(ctx context.Context, q Querier, id uuid.UUID, maxAttempts int, lockout time.Duration) error {
	_, err := q.Exec(ctx, `
		UPDATE users SET
			failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $1 THEN 0 ELSE failed_login_attempts + 1 END,
			locked_until = CASE WHEN failed_login_attempts + 1 >= $1
				THEN now() + make_interval(secs => $2) ELSE locked_until END
		WHERE id = $3`, maxAttempts, lockout.Seconds(), id)
	return err
}

// RecordSuccessfulLogin setzt Fehlversuche zurück und speichert optional einen neuen Hash.
func RecordSuccessfulLogin(ctx context.Context, q Querier, id uuid.UUID, newHash *string) error {
	_, err := q.Exec(ctx, `
		UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(),
			password_hash = COALESCE($1, password_hash)
		WHERE id = $2`, newHash, id)
	return err
}

func UpdateUserTimezone(ctx context.Context, q Querier, id uuid.UUID, tz string) error {
	_, err := q.Exec(ctx, `UPDATE users SET timezone = $1 WHERE id = $2`, tz, id)
	return err
}

// UpdatePassword speichert einen neuen Passwort-Hash und setzt Fehlversuche zurück.
func UpdatePassword(ctx context.Context, q Querier, id uuid.UUID, hash string) error {
	_, err := q.Exec(ctx, `UPDATE users SET password_hash = $1, password_changed_at = now(),
		failed_login_attempts = 0, locked_until = NULL WHERE id = $2`, hash, id)
	return err
}
