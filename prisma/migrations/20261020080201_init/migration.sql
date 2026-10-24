-- CreateTable
CREATE TABLE "admins" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'admin',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_logs" (
    "id" SERIAL NOT NULL,
    "admin_id" INTEGER,
    "action" VARCHAR(50) NOT NULL,
    "details" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" SERIAL NOT NULL,
    "team_name" VARCHAR(50) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bids" (
    "id" SERIAL NOT NULL,
    "team_id" INTEGER NOT NULL,
    "prompt_id" INTEGER NOT NULL,
    "bid_minutes" INTEGER NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" SERIAL NOT NULL,
    "team_id" INTEGER NOT NULL,
    "prompt_id" INTEGER NOT NULL,
    "bid_minutes" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "multiplier" DECIMAL(5,3) NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scores" (
    "id" SERIAL NOT NULL,
    "team_id" INTEGER NOT NULL,
    "judge_score" INTEGER NOT NULL,
    "multiplier" DECIMAL(5,3) NOT NULL,
    "final_score" DECIMAL(8,3) NOT NULL,
    "scored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_config" (
    "id" SERIAL NOT NULL,
    "base_time" INTEGER NOT NULL DEFAULT 120,
    "min_bid" INTEGER NOT NULL DEFAULT 30,
    "max_teams" INTEGER NOT NULL DEFAULT 10,
    "slots_per_prompt" INTEGER NOT NULL DEFAULT 3,
    "bid_duration_seconds" INTEGER NOT NULL DEFAULT 60,
    "current_round" INTEGER NOT NULL DEFAULT 0,
    "current_prompt_index" INTEGER NOT NULL DEFAULT -1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'waiting',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE UNIQUE INDEX "teams_team_name_key" ON "teams"("team_name");

-- CreateIndex
CREATE UNIQUE INDEX "bids_team_id_prompt_id_round_key" ON "bids"("team_id", "prompt_id", "round");

-- CreateIndex
CREATE UNIQUE INDEX "bids_prompt_id_bid_minutes_round_key" ON "bids"("prompt_id", "bid_minutes", "round");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_team_id_key" ON "assignments"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "scores_team_id_key" ON "scores"("team_id");

-- AddForeignKey
ALTER TABLE "admin_logs" ADD CONSTRAINT "admin_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
