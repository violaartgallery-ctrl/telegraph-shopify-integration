CREATE TABLE "LocationCatalogSnapshot" (
    "id" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "governorateCount" INTEGER NOT NULL,
    "areaCount" INTEGER NOT NULL,
    "sourceFetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationCatalogSnapshot_pkey" PRIMARY KEY ("id")
);
