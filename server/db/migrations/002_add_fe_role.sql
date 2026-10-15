-- 新增前端（FE）角色 + 需求前端负责人 fe_id
-- 保留原 RD（后端研发）角色，FE 与 RD 并行；一张需求可同时指派 RD / FE

ALTER TABLE users DROP CHECK chk_users_role;

ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN ('CSM', 'PO', 'RD', 'QA', 'FE', 'ADMIN'));

ALTER TABLE requirements ADD COLUMN fe_id BIGINT UNSIGNED NULL AFTER rd_id;

ALTER TABLE requirements ADD CONSTRAINT fk_requirements_fe FOREIGN KEY (fe_id) REFERENCES users(id) ON DELETE SET NULL;
