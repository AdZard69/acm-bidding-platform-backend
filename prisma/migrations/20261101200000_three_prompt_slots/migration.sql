-- Restore the event capacity for deployments configured with two winning teams.
UPDATE "game_config" SET "slots_per_prompt" = 3 WHERE "slots_per_prompt" = 2;
