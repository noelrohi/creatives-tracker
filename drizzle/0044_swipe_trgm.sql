CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "studio_swipe_brand_trgm_idx" ON "studio_swipe" USING gin ("brand_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "studio_swipe_why_trgm_idx" ON "studio_swipe" USING gin ("why_it_works" gin_trgm_ops);
