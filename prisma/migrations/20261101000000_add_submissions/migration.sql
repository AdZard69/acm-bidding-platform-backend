-- Existing deployments may already have the table from the former startup fallback.
CREATE TABLE IF NOT EXISTS "submissions" (
    "id" SERIAL NOT NULL,
    "team_id" INTEGER NOT NULL,
    "github_url" VARCHAR(500) NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "submissions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Normalize tables created by the old raw SQL to the Prisma schema.
ALTER TABLE "submissions"
    ALTER COLUMN "team_id" SET NOT NULL,
    ALTER COLUMN "submitted_at" TYPE TIMESTAMP(3),
    ALTER COLUMN "submitted_at" SET NOT NULL,
    ALTER COLUMN "updated_at" TYPE TIMESTAMP(3),
    ALTER COLUMN "updated_at" SET NOT NULL,
    ALTER COLUMN "updated_at" DROP DEFAULT;
CREATE UNIQUE INDEX IF NOT EXISTS "submissions_team_id_key" ON "submissions"("team_id");
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_team_id_fkey";
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
