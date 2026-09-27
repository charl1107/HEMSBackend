-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "program" TEXT,
ADD COLUMN     "studentId" TEXT,
ADD COLUMN     "yearLevel" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "User_studentId_key" ON "User"("studentId");
