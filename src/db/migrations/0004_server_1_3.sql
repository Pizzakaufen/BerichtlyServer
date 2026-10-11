-- Berichtly Server 1.3 – Prüf- und Freigabestatus (Berichtly App 3.0).
--
-- Erweitert die erlaubten Statuswerte der Tages- und Wochenberichte um
--   REVIEW_REQUIRED  (Prüfung erforderlich) und
--   APPROVED         (Freigegeben).
-- Bestehende Daten bleiben unverändert; ältere Apps senden diese Werte nie.
-- Die Namen der CHECK-Bedingungen sind die von PostgreSQL vergebenen Standardnamen aus 0001.

ALTER TABLE daily_reports DROP CONSTRAINT IF EXISTS daily_reports_status_check;
ALTER TABLE daily_reports ADD CONSTRAINT daily_reports_status_check
    CHECK (status IN ('DRAFT', 'GENERATED', 'EDITED', 'FINALIZED', 'REVIEW_REQUIRED', 'APPROVED'));

ALTER TABLE weekly_reports DROP CONSTRAINT IF EXISTS weekly_reports_status_check;
ALTER TABLE weekly_reports ADD CONSTRAINT weekly_reports_status_check
    CHECK (status IN ('DRAFT', 'GENERATED', 'EDITED', 'FINALIZED', 'REVIEW_REQUIRED', 'APPROVED'));
