import { drizzle } from 'drizzle-orm/netlify-db'
import * as schema from './schema'
export const database = () => drizzle({ schema })
