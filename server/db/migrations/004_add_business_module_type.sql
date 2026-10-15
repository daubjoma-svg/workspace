ALTER TABLE business_modules ADD COLUMN type VARCHAR(16) NOT NULL DEFAULT 'BACKEND' AFTER name;
ALTER TABLE business_modules ADD CONSTRAINT chk_business_modules_type CHECK (type IN ('FRONTEND','BACKEND'));
