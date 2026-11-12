-- Alerts as HTML for email, next to their text, so an alert sent again looks as it did the first
-- time. Alerts kept before this have none and go as text.
ALTER TABLE alert ADD COLUMN html TEXT;
