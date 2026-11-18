-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'BANK', 'ADMIN');

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "student_no" VARCHAR(8) NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL,
    "student_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tuitions" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "term" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tuitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "transaction_id" VARCHAR(64) NOT NULL,
    "tuition_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paid_by_user_id" UUID,
    "paid_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "students_student_no_key" ON "students"("student_no");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_student_id_key" ON "users"("student_id");

-- CreateIndex
CREATE INDEX "tuitions_term_idx" ON "tuitions"("term");

-- CreateIndex
CREATE UNIQUE INDEX "tuitions_student_id_term_key" ON "tuitions"("student_id", "term");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- CreateIndex
CREATE INDEX "payments_tuition_id_idx" ON "payments"("tuition_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tuitions" ADD CONSTRAINT "tuitions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tuition_id_fkey" FOREIGN KEY ("tuition_id") REFERENCES "tuitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_by_user_id_fkey" FOREIGN KEY ("paid_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints (added by hand; Prisma cannot express them in schema.prisma).
-- They repeat the API validation rules at database level (README §12.5, docs/API.md).
ALTER TABLE "students" ADD CONSTRAINT "students_student_no_format_chk" CHECK ("student_no" ~ '^[0-9]{8}$');

ALTER TABLE "users" ADD CONSTRAINT "users_student_link_chk" CHECK (("role" = 'STUDENT') = ("student_id" IS NOT NULL));

ALTER TABLE "tuitions" ADD CONSTRAINT "tuitions_term_format_chk" CHECK ("term" ~ '^[0-9]{4}-(FALL|SPRING|SUMMER)$');
ALTER TABLE "tuitions" ADD CONSTRAINT "tuitions_amount_range_chk" CHECK ("amount" > 0 AND "amount" <= 1000000);
ALTER TABLE "tuitions" ADD CONSTRAINT "tuitions_currency_chk" CHECK ("currency" = 'USD');

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive_chk" CHECK ("amount" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_transaction_id_format_chk" CHECK ("transaction_id" ~ '^[A-Za-z0-9_-]{8,64}$');
