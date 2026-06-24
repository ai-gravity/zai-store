import app from '../src/index.js'
import { handle } from 'hono/cloudflare-pages'

export const onRequest = handle(app)
