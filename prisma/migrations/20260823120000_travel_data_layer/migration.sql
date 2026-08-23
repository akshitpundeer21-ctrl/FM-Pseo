-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "officialName" TEXT,
    "iso2" TEXT NOT NULL,
    "iso3" TEXT,
    "continent" TEXT,
    "region" TEXT,
    "currencyCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "countryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "type" TEXT NOT NULL DEFAULT 'REGION',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Region_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "regionId" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "timezone" TEXT,
    "population" INTEGER,
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "City_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "City_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Airport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "iata" TEXT NOT NULL,
    "icao" TEXT,
    "cityId" TEXT,
    "countryId" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "timezone" TEXT,
    "type" TEXT NOT NULL DEFAULT 'INTERNATIONAL',
    "terminals" INTEGER,
    "isHub" BOOLEAN NOT NULL DEFAULT false,
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Airport_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Airport_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Airline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "iata" TEXT,
    "icao" TEXT,
    "countryId" TEXT,
    "callsign" TEXT,
    "alliance" TEXT,
    "type" TEXT NOT NULL DEFAULT 'FULL_SERVICE',
    "hubsJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Airline_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originAirportId" TEXT NOT NULL,
    "destinationAirportId" TEXT NOT NULL,
    "originCityId" TEXT,
    "destinationCityId" TEXT,
    "routeType" TEXT NOT NULL DEFAULT 'MIXED',
    "distanceKm" REAL,
    "typicalDurationMinutes" INTEGER,
    "typicalStops" INTEGER,
    "nonstopAvailable" BOOLEAN NOT NULL DEFAULT false,
    "frequency" INTEGER,
    "cabinClassesJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "method" TEXT,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Route_originAirportId_fkey" FOREIGN KEY ("originAirportId") REFERENCES "Airport" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Route_destinationAirportId_fkey" FOREIGN KEY ("destinationAirportId") REFERENCES "Airport" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Route_originCityId_fkey" FOREIGN KEY ("originCityId") REFERENCES "City" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Route_destinationCityId_fkey" FOREIGN KEY ("destinationCityId") REFERENCES "City" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RouteAirline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "routeId" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL DEFAULT 'NONSTOP',
    "frequency" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RouteAirline_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RouteAirline_airlineId_fkey" FOREIGN KEY ("airlineId") REFERENCES "Airline" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Destination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cityId" TEXT NOT NULL,
    "countryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "travelAttributesJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'STATIC_DATASET',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Destination_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Destination_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TravelPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyType" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "counterpartKey" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "detailJson" TEXT NOT NULL DEFAULT '{}',
    "effectiveFrom" DATETIME,
    "effectiveTo" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "provider" TEXT,
    "providerRecordId" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.4,
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProviderCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestParamsJson" TEXT NOT NULL DEFAULT '{}',
    "responseJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'FRESH',
    "error" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Country_iso2_key" ON "Country"("iso2");

-- CreateIndex
CREATE INDEX "Country_status_idx" ON "Country"("status");

-- CreateIndex
CREATE INDEX "Region_countryId_idx" ON "Region"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_countryId_name_key" ON "Region"("countryId", "name");

-- CreateIndex
CREATE INDEX "City_name_idx" ON "City"("name");

-- CreateIndex
CREATE UNIQUE INDEX "City_countryId_name_key" ON "City"("countryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Airport_iata_key" ON "Airport"("iata");

-- CreateIndex
CREATE INDEX "Airport_cityId_idx" ON "Airport"("cityId");

-- CreateIndex
CREATE INDEX "Airport_countryId_idx" ON "Airport"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "Airline_iata_key" ON "Airline"("iata");

-- CreateIndex
CREATE INDEX "Airline_countryId_idx" ON "Airline"("countryId");

-- CreateIndex
CREATE INDEX "Route_originCityId_destinationCityId_idx" ON "Route"("originCityId", "destinationCityId");

-- CreateIndex
CREATE UNIQUE INDEX "Route_originAirportId_destinationAirportId_key" ON "Route"("originAirportId", "destinationAirportId");

-- CreateIndex
CREATE INDEX "RouteAirline_airlineId_idx" ON "RouteAirline"("airlineId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteAirline_routeId_airlineId_key" ON "RouteAirline"("routeId", "airlineId");

-- CreateIndex
CREATE INDEX "Destination_countryId_idx" ON "Destination"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "Destination_cityId_name_key" ON "Destination"("cityId", "name");

-- CreateIndex
CREATE INDEX "TravelPolicy_subjectType_subjectKey_idx" ON "TravelPolicy"("subjectType", "subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "TravelPolicy_policyType_subjectType_subjectKey_counterpartKey_key" ON "TravelPolicy"("policyType", "subjectType", "subjectKey", "counterpartKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCache_requestHash_key" ON "ProviderCache"("requestHash");

-- CreateIndex
CREATE INDEX "ProviderCache_provider_namespace_idx" ON "ProviderCache"("provider", "namespace");

-- CreateIndex
CREATE INDEX "ProviderCache_expiresAt_idx" ON "ProviderCache"("expiresAt");

