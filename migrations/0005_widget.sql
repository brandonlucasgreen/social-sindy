-- Embeddable widget: a third output format alongside 'ics' and 'atom'.
--
-- The widget's appearance (theme, accent, font, size, dimensions, toggles) is
-- stored as one JSON column rather than a column per knob: only widget outputs
-- read it, it is validated against allowlists on every read (see
-- src/widget/style.ts), and new appearance options should not each need a
-- migration. Null means "all defaults".
ALTER TABLE outputs ADD COLUMN widget_style TEXT;
