ALTER TABLE user ADD COLUMN role TEXT NOT NULL DEFAULT 'view';

UPDATE user
SET role = 'admin'
WHERE id = (
  SELECT id
  FROM user
  ORDER BY createdAt ASC
  LIMIT 1
);
