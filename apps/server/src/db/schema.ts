import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import type { EntryRecord } from "../data/types"

export const feeds = pgTable(
  "feeds",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    title: text("title"),
    description: text("description"),
    siteUrl: text("site_url"),
    image: text("image"),
    ownerUserId: text("owner_user_id"),
    errorAt: timestamp("error_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("feeds_url_unique").on(table.url)],
)

export const entries = pgTable(
  "entries",
  {
    id: text("id").primaryKey(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    guid: text("guid").notNull(),
    title: text("title"),
    description: text("description"),
    content: text("content"),
    url: text("url"),
    author: text("author"),
    authorUrl: text("author_url"),
    authorAvatar: text("author_avatar"),
    language: text("language"),
    categories: jsonb("categories").$type<EntryRecord["categories"]>(),
    attachments: jsonb("attachments").$type<EntryRecord["attachments"]>(),
    media: jsonb("media").$type<EntryRecord["media"]>(),
    extra: jsonb("extra").$type<EntryRecord["extra"]>(),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("entries_feed_guid_unique").on(table.feedId, table.guid),
    index("entries_feed_published_idx").on(table.feedId, table.publishedAt),
  ],
)

export const subscriptions = pgTable(
  "subscriptions",
  {
    userId: text("user_id").notNull(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    view: integer("view").notNull(),
    category: text("category"),
    title: text("title"),
    isPrivate: boolean("is_private").notNull(),
    hideFromTimeline: boolean("hide_from_timeline"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.feedId] }),
    index("subscriptions_user_view_idx").on(table.userId, table.view),
  ],
)

export const readStates = pgTable(
  "read_states",
  {
    userId: text("user_id").notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.entryId] })],
)

export const collections = pgTable(
  "collections",
  {
    userId: text("user_id").notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.entryId] })],
)

export const settings = pgTable(
  "settings",
  {
    userId: text("user_id").notNull(),
    tab: text("tab").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.tab] })],
)
