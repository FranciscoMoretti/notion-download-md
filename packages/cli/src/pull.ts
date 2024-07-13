import * as Path from "path"
import { exit } from "process"
import {
  Client,
  isFullBlock,
  isFullDatabase,
  isFullPage,
} from "@notionhq/client"
import {
  BlockObjectResponse,
  DatabaseObjectResponse,
  GetDatabaseResponse,
  GetPageResponse,
  ListBlockChildrenResponse,
  PageObjectResponse,
  QueryDatabaseParameters,
  QueryDatabaseResponse,
} from "@notionhq/client/build/src/api-endpoints"
import fs from "fs-extra"
import { NotionToMarkdown } from "notion-to-md"
import { ListBlockChildrenResponseResults } from "notion-to-md/build/types"

import { HierarchicalNamedLayoutStrategy } from "./HierarchicalNamedLayoutStrategy"
import { LayoutStrategy } from "./LayoutStrategy"
import { NotionPage, PageType, getPageContentInfo } from "./NotionPage"
import { IDocuNotionConfig, loadConfigAsync } from "./config/configuration"
import { executeWithRateLimitAndRetries } from "./executeWithRateLimitAndRetries"
import { cleanupOldImages, initImageHandling } from "./images"
import { endGroup, error, group, info, logDebug, verbose, warning } from "./log"
import { convertInternalUrl } from "./plugins/internalLinks"
import { IDocuNotionContext } from "./plugins/pluginTypes"
import { getMarkdownForPage } from "./transform"
import { NotionBlock } from "./types"

type ImageFileNameFormat = "default" | "content-hash" | "legacy"
export type DocuNotionOptions = {
  notionToken: string
  rootPage: string
  rootIsDb?: boolean
  locales: string[]
  markdownOutputPath: string
  imgOutputPath: string
  imgPrefixInMarkdown: string
  statusTag: string
  requireSlugs?: boolean
  imageFileNameFormat?: ImageFileNameFormat
}

let layoutStrategy: LayoutStrategy
let notionToMarkdown: NotionToMarkdown
const pages = new Array<NotionPage>()

type NotionObject = "database" | "page" | "block"

type NotionObjectTreeNode = {
  id: string
  object: NotionObject
  children: Array<NotionObjectTreeNode>
}

type ObjectsCache = Record<
  string,
  PageObjectResponse | DatabaseObjectResponse | BlockObjectResponse
>

const counts = {
  output_normally: 0,
  skipped_because_empty: 0,
  skipped_because_status: 0,
  skipped_because_level_cannot_have_content: 0,
  error_because_no_slug: 0,
}

export async function notionPull(options: DocuNotionOptions): Promise<void> {
  // It's helpful when troubleshooting CI secrets and environment variables to see what options actually made it to docu-notion.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const optionsForLogging = { ...options }
  // Just show the first few letters of the notion token, which start with "secret" anyhow.
  optionsForLogging.notionToken =
    optionsForLogging.notionToken.substring(0, 10) + "..."

  // TODO: This should be moved up to the pull command that already loads configs
  const config = await loadConfigAsync()

  verbose(`Options:${JSON.stringify(optionsForLogging, null, 2)}`)
  await initImageHandling(
    options.imgPrefixInMarkdown || options.imgOutputPath || "",
    options.imgOutputPath || "",
    options.locales
  )

  // TODO: HACK: until we can add the notion token to the config
  options.statusTag = "Published"

  const notionClient = initNotionClient(options.notionToken)
  notionToMarkdown = new NotionToMarkdown({ notionClient })

  layoutStrategy = new HierarchicalNamedLayoutStrategy()

  await fs.mkdir(options.markdownOutputPath, { recursive: true })
  await fs.mkdir(options.markdownOutputPath.replace(/\/+$/, "") + "/.cache", {
    recursive: true,
  })

  layoutStrategy.setRootDirectoryForMarkdown(
    options.markdownOutputPath.replace(/\/+$/, "") // trim any trailing slash
  )

  info("Connecting to Notion...")

  // Do a  quick test to see if we can connect to the root so that we can give a better error than just a generic "could not find page" one.
  // TODO: Get root page, which can be DB or can be single page
  try {
    if (options.rootIsDb) {
      await retrieveDatabase(options.rootPage)
    } else {
      await executeWithRateLimitAndRetries("retrieving root page", async () => {
        await notionClient.pages.retrieve({ page_id: options.rootPage })
      })
    }
  } catch (e: any) {
    error(
      `docu-notion could not retrieve the root page from Notion. \r\na) Check that the root page id really is "${
        options.rootPage
      }".\r\nb) Check that your Notion API token (the "Integration Secret") is correct. It starts with "${
        optionsForLogging.notionToken
      }".\r\nc) Check that your root page includes your "integration" in its "connections".\r\nThis internal error message may help:\r\n    ${
        e.message as string
      }".\r\nd) Check that your root-is-db option is being used correctly. Current value is: ${
        options.rootIsDb
      }\r\n`
    )
    exit(1)
  }

  const objectCache = {}
  // Page tree that stores relationship between pages and their children. It can store children recursively in any depth.
  const objectsTree: NotionObjectTreeNode = {
    id: options.rootPage,
    object: options.rootIsDb ? "database" : "page",
    children: [],
  }

  group(
    "Stage 1: walk children of the page named 'Outline', looking for pages..."
  )
  // TODO: Merge recursively get pages with getting pages from DB. This fails if the rootpage is a DB
  // await getPagesRecursively(options, "", options.rootPage, 0, true)
  await fetchTreeRecursively(objectsTree, objectCache)

  // Database to pages array
  // TODO: Save page metadata and content while fetching
  // const pagesPromises = firstResponse.results.map((page: GetPageResponse) => {
  //   const notionPage = fromPageId("", page.id, 0, true)
  //   return notionPage
  // })
  // await Promise.all(pagesPromises).then((results) => {
  //   results.forEach((resultPage) => {
  //     console.log(resultPage)
  //     pages.push(resultPage)
  //   })
  // })

  logDebug("getPagesRecursively", JSON.stringify(pages, null, 2))
  // Save pages to a json file
  await saveDataToJson(
    objectCache,
    options.markdownOutputPath.replace(/\/+$/, "") +
      "/.cache/" +
      "objects_cache.json"
  )
  await saveDataToJson(
    objectsTree,
    options.markdownOutputPath.replace(/\/+$/, "") +
      "/.cache/" +
      "object_tree.json"
  )
  await saveDataToJson(
    pages,
    options.markdownOutputPath.replace(/\/+$/, "") + "/.cache/" + "pages.json"
  )

  info(`Found ${pages.length} pages`)
  endGroup()
  group(
    `Stage 2: convert ${pages.length} Notion pages to markdown and convertNotionLinkToLocalDocusaurusLink locally...`
  )
  await outputPages(options, config, pages)
  endGroup()
  group("Stage 3: clean up old files & images...")
  await layoutStrategy.cleanupOldFiles()
  await cleanupOldImages()
  endGroup()
}

async function saveDataToJson(data: any, filename: string) {
  const json = JSON.stringify(data, null, 2)
  await fs.writeFile(filename, json)
}

async function outputPages(
  options: DocuNotionOptions,
  config: IDocuNotionConfig,
  pages: Array<NotionPage>
) {
  const context: IDocuNotionContext = {
    getBlockChildren: getBlockChildren,
    // this changes with each page
    pageInfo: {
      directoryContainingMarkdown: "",
      relativeFilePathToFolderContainingPage: "",
      slug: "",
    },
    layoutStrategy: layoutStrategy,
    notionToMarkdown: notionToMarkdown,
    options: options,
    pages: pages,
    counts: counts, // review will this get copied or pointed to?
    imports: [],
    convertNotionLinkToLocalDocusaurusLink: (url: string) =>
      convertInternalUrl(context, url),
  }
  for (const page of pages) {
    layoutStrategy.pageWasSeen(page)
    const mdPath = layoutStrategy.getPathForPage(page, ".md")

    // most plugins should not write to disk, but those handling image files need these paths
    context.pageInfo.directoryContainingMarkdown = Path.dirname(mdPath)
    // TODO: This needs clarifying: getLinkPathForPage() is about urls, but
    // downstream images.ts is using it as a file system path
    context.pageInfo.relativeFilePathToFolderContainingPage = Path.dirname(
      layoutStrategy.getLinkPathForPage(page)
    )
    context.pageInfo.slug = page.slug

    if (
      page.type === PageType.DatabasePage &&
      context.options.statusTag != "*" &&
      page.status !== context.options.statusTag
    ) {
      verbose(
        `Skipping page because status is not '${context.options.statusTag}': ${page.nameOrTitle}`
      )
      ++context.counts.skipped_because_status
    } else {
      if (options.requireSlugs && !page.hasExplicitSlug) {
        error(
          `Page "${page.nameOrTitle}" is missing a required slug. (--require-slugs is set.)`
        )
        ++counts.error_because_no_slug
      }

      const markdown = await getMarkdownForPage(config, context, page)
      writePage(page, markdown)
    }
  }

  if (counts.error_because_no_slug > 0) exit(1)

  info(`Finished processing ${pages.length} pages`)
  info(JSON.stringify(counts))
}

async function fetchTreeRecursively(
  objectNode: NotionObjectTreeNode,
  objectsCache: ObjectsCache
  // TODO: add second argument to store responses from blocks and pages
) {
  info(
    `Looking for children of {pageId: "${objectNode.id}", type: "${objectNode.object}"}`
  )

  if (objectNode.object === "database") {
    const databaseResponse = await queryDatabase(objectNode.id)

    for (const childObject of databaseResponse.results) {
      const newNode: NotionObjectTreeNode = {
        id: childObject.id,
        object: childObject.object,
        children: [],
      }
      // Save object to cache
      if (childObject.object == "database" && isFullDatabase(childObject)) {
        objectsCache[childObject.id] = childObject
      } else if (childObject.object == "page" && isFullPage(childObject)) {
        objectsCache[childObject.id] = childObject
      }

      objectNode.children.push(newNode)
      await fetchTreeRecursively(newNode, objectsCache)
    }
  } else if (objectNode.object === "page") {
    // TODO: Fix the inconsistency. In the block case, the non-full object response is handled in getBlockChildren()
    const blocksResponse = await getBlockChildren(objectNode.id)
    for (const childBlock of blocksResponse) {
      objectsCache[childBlock.id] = childBlock
      if (
        // TODO: Decide how to handle "mentions" (links to other objects)
        childBlock.type == "child_page" ||
        childBlock.type == "child_database"
      ) {
        const newNode: NotionObjectTreeNode = {
          id: childBlock.id,
          object: childBlock.type == "child_database" ? "database" : "page",
          children: [],
        }
        objectNode.children.push(newNode)
        await fetchTreeRecursively(newNode, objectsCache)
      }
    }
  } else if (objectNode.object === "block") {
    // TODO: Handle links? Shouldn't be nested, but maybe they should be fetched.
  }
}

// This walks the "Outline" page and creates a list of all the nodes that will
// be in the sidebar, including the directories, the pages that are linked to
// that are parented in from the "Database", and any pages we find in the
// outline that contain content (which we call "Simple" pages). Later, we can
// then step through this list creating the files we need, and, crucially, be
// able to figure out what the url will be for any links between content pages.
async function getPagesRecursively(
  options: DocuNotionOptions,
  incomingContext: string,
  pageIdOfThisParent: string,
  orderOfThisParent: number,
  rootLevel: boolean
) {
  const pageInTheOutline = await fromPageId(
    incomingContext,
    pageIdOfThisParent,
    orderOfThisParent,
    true
  )

  info(
    `Looking for children and links from ${incomingContext}/${pageInTheOutline.nameOrTitle}`
  )

  const r = await getBlockChildren(pageInTheOutline.pageId)
  const pageInfo = await getPageContentInfo(r)

  if (
    !rootLevel &&
    pageInfo.hasParagraphs &&
    pageInfo.childPageIdsAndOrder.length
  ) {
    error(
      `Skipping "${pageInTheOutline.nameOrTitle}"  and its children. docu-notion does not support pages that are both levels and have text content (paragraphs) at the same time. Normally outline pages should just be composed of 1) links to other pages and 2) child pages (other levels of the outline). Note that @-mention style links appear as text paragraphs to docu-notion so must not be used to form the outline.`
    )
    ++counts.skipped_because_level_cannot_have_content
    return
  }
  if (!rootLevel && pageInfo.hasParagraphs) {
    pages.push(pageInTheOutline)

    // The best practice is to keep content pages in the "database" (e.g. kanban board), but we do allow people to make pages in the outline directly.
    // So how can we tell the difference between a page that is supposed to be content and one that is meant to form the sidebar? If it
    // has only links, then it's a page for forming the sidebar. If it has contents and no links, then it's a content page. But what if
    // it has both? Well then we assume it's a content page.
    if (pageInfo.linksPageIdsAndOrder?.length) {
      warning(
        `Note: The page "${pageInTheOutline.nameOrTitle}" is in the outline, has content, and also points at other pages. It will be treated as a simple content page. This is no problem, unless you intended to have all your content pages in the database (kanban workflow) section.`
      )
    }
  }
  // a normal outline page that exists just to create the level, pointing at database pages that belong in this level
  else if (
    // TODO: This is disabled because instead page links are handled in the db
    // pageInfo.linksPageIdsAndOrder.length ||
    pageInfo.childPageIdsAndOrder.length
  ) {
    let layoutContext = incomingContext
    // don't make a level for "Outline" page at the root
    if (!rootLevel && pageInTheOutline.nameOrTitle !== "Outline") {
      layoutContext = layoutStrategy.newLevel(
        options.markdownOutputPath,
        pageInTheOutline.order,
        incomingContext,
        pageInTheOutline.nameOrTitle
      )
    }
    for (const childPageInfo of pageInfo.childPageIdsAndOrder) {
      await getPagesRecursively(
        options,
        layoutContext,
        childPageInfo.id,
        childPageInfo.order,
        false
      )
    }

    // TODO: This is disabled because instead page links are handled in the db
    // for (const linkPageInfo of pageInfo.linksPageIdsAndOrder) {
    //   pages.push(
    //     await fromPageId(
    //       layoutContext,
    //       linkPageInfo.id,
    //       linkPageInfo.order,
    //       false
    //     )
    //   )
    // }
  } else {
    console.info(
      warning(
        `Warning: The page "${pageInTheOutline.nameOrTitle}" is in the outline but appears to not have content, links to other pages, or child pages. It will be skipped.`
      )
    )
    ++counts.skipped_because_empty
  }
}

function writePage(page: NotionPage, finalMarkdown: string) {
  const mdPath = layoutStrategy.getPathForPage(page, ".md")
  verbose(`writing ${mdPath}`)
  fs.writeFileSync(mdPath, finalMarkdown, {})
  ++counts.output_normally
}

let notionClient: Client

async function getPageMetadata(id: string): Promise<GetPageResponse> {
  return await executeWithRateLimitAndRetries(`pages.retrieve(${id})`, () => {
    return notionClient.pages.retrieve({
      page_id: id,
    })
  })
}

async function queryDatabase(
  id: string,
  parameters?: QueryDatabaseParameters
): Promise<QueryDatabaseResponse> {
  // TODO: Query on a while loop until no more pages available
  return await executeWithRateLimitAndRetries(
    `database.retrieve(${id})`,
    () => {
      return notionClient.databases.query({
        database_id: id,
        ...parameters,
      })
    }
  )
}

async function retrieveDatabase(id: string): Promise<GetDatabaseResponse> {
  return await executeWithRateLimitAndRetries(
    `database.retrieve(${id})`,
    () => {
      return notionClient.databases.retrieve({
        database_id: id,
      })
    }
  )
}

async function getBlockChildren(id: string): Promise<NotionBlock[]> {
  // we can only get so many responses per call, so we set this to
  // the first response we get, then keep adding to its array of blocks
  // with each subsequent response
  let overallResult: ListBlockChildrenResponse | undefined = undefined
  let start_cursor: string | undefined | null = undefined

  // Note: there is a now a collectPaginatedAPI() in the notion client, so
  // we could switch to using that (I don't know if it does rate limiting?)
  do {
    const response: ListBlockChildrenResponse =
      await executeWithRateLimitAndRetries(`getBlockChildren(${id})`, () => {
        return notionClient.blocks.children.list({
          start_cursor: start_cursor as string | undefined,
          block_id: id,
        })
      })

    if (!overallResult) {
      overallResult = response
    } else {
      overallResult.results.push(...response.results)
    }

    start_cursor = response?.next_cursor
  } while (start_cursor != null)

  if (overallResult?.results?.some((b) => !isFullBlock(b))) {
    error(
      `The Notion API returned some blocks that were not full blocks. docu-notion does not handle this yet. Please report it.`
    )
    exit(1)
  }

  const result = (overallResult?.results as BlockObjectResponse[]) ?? []
  // TODO - rething if this numbering should be part of the downloading part of the app, or of the processing part
  numberChildrenIfNumberedList(result)
  return result
}
export function initNotionClient(notionToken: string): Client {
  notionClient = new Client({
    auth: notionToken,
  })
  return notionClient
}
async function fromPageId(
  context: string,
  pageId: string,
  order: number,
  foundDirectlyInOutline: boolean
): Promise<NotionPage> {
  const metadata = await getPageMetadata(pageId)

  //logDebug("notion metadata", JSON.stringify(metadata));
  return new NotionPage({
    layoutContext: context,
    pageId,
    order,
    metadata,
    foundDirectlyInOutline,
  })
}

// This function is copied (and renamed from modifyNumberedListObject) from notion-to-md.
// They always run it on the results of their getBlockChildren.
// When we use our own getBlockChildren, we need to run it too.
export function numberChildrenIfNumberedList(
  blocks: ListBlockChildrenResponseResults
): void {
  let numberedListIndex = 0

  for (const block of blocks) {
    if ("type" in block && block.type === "numbered_list_item") {
      // add numbers
      // @ts-ignore
      block.numbered_list_item.number = ++numberedListIndex
    } else {
      numberedListIndex = 0
    }
  }
}
