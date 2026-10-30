-- Persist the active prompt order and countdown for restart recovery.
ALTER TABLE "game_config" ADD COLUMN "bidding_state" JSONB;
