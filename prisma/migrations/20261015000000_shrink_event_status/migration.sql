-- Backfill legacy event statuses into the four-value lifecycle (Task 12).
-- Must run BEFORE the enum shrink below: the old enum values are still
-- present here, so the UPDATEs can name them.
UPDATE "Event" SET status = 'Planning'   WHERE status IN ('Draft','PendingApproval','RevisionRequired','Approved');
UPDATE "Event" SET status = 'Cancelled'  WHERE status = 'Rejected';

-- Shrink "EventStatus" to exactly Planning/Ongoing/Completed/Cancelled via
-- the Prisma enum-drop path (rename old type, create new, cast, drop).
-- "NotificationType" and the legacy enums ("ApprovalAction",
-- "AttendanceStatus", "ParticipantType", "RegistrationStatus") are untouched.
ALTER TYPE "EventStatus" RENAME TO "EventStatus_old";

CREATE TYPE "EventStatus" AS ENUM ('Planning', 'Ongoing', 'Completed', 'Cancelled');

ALTER TABLE "Event" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Event" ALTER COLUMN "status" TYPE "EventStatus" USING status::text::"EventStatus";
ALTER TABLE "Event" ALTER COLUMN "status" SET DEFAULT 'Planning';

DROP TYPE "EventStatus_old";
