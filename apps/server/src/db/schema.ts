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

export const entryReadability = pgTable("entry_readability", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
})

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

export const instanceOwnership = pgTable("instance_ownership", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})

export const lists = pgTable(
  "lists",
  {
    id: text("id").primaryKey(),
    feedIds: text("feed_ids").array().notNull(),
    title: text("title").notNull(),
    description: text("description"),
    image: text("image"),
    view: integer("view").notNull(),
    fee: integer("fee").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("lists_owner_idx").on(table.ownerUserId)],
)

export const listSubscriptions = pgTable(
  "list_subscriptions",
  {
    userId: text("user_id").notNull(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    view: integer("view").notNull(),
    category: text("category"),
    title: text("title"),
    isPrivate: boolean("is_private").notNull(),
    hideFromTimeline: boolean("hide_from_timeline"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.listId] }),
    index("list_subscriptions_user_view_idx").on(table.userId, table.view),
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
