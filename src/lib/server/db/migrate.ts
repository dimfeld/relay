import { openDatabase } from "./index";

const databasePath = process.env.DATABASE_PATH;
if (!databasePath) throw new Error("DATABASE_PATH must be set to run database migrations");

const db = openDatabase(databasePath);
db.close();
