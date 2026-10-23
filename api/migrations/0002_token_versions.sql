-- 予約URL再発行時に入場QR・クーポンQRも無効化できるよう、トークンの版を持たせる
ALTER TABLE admission_tickets ADD COLUMN token_version integer NOT NULL DEFAULT 0;
ALTER TABLE issued_coupons ADD COLUMN token_version integer NOT NULL DEFAULT 0;
