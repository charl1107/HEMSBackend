-- Additive event classification fields. Existing events remain on campus
-- until their department/location is explicitly updated.
CREATE TYPE "EventCampusScope" AS ENUM ('OnCampus', 'OffCampus');

ALTER TABLE "Event"
ADD COLUMN "department" TEXT,
ADD COLUMN "campusScope" "EventCampusScope" NOT NULL DEFAULT 'OnCampus';