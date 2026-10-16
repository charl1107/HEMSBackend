-- The Department field was removed from the app during the events-only rework.
-- IF EXISTS keeps this a no-op on databases where the column was already dropped.
ALTER TABLE "Event" DROP COLUMN IF EXISTS "department";
