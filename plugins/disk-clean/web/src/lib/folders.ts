import {linkOptions} from '@tanstack/react-router'
import {nearestFolder, type TreeNode} from './data'
import {fullToken, knownPathOf, shortOf} from './selection'

const FOLDER_TOKEN = /^([0-9a-z]{8}|[0-9a-z]{11})$/

export const folderTokenOf = (raw: string) => (FOLDER_TOKEN.test(raw) ? raw : '')

interface FolderIndex {
  tokenOf: (path: string) => string
  pathOf: (token: string) => string | undefined
}

const indexes = new WeakMap<TreeNode, FolderIndex>()

function buildIndex(tree: TreeNode): FolderIndex {
  const counts = new Map<string, number>()
  const paths = new Map<string, string>()
  const visit = (node: TreeNode) => {
    const short = shortOf(node.path)
    counts.set(short, (counts.get(short) ?? 0) + 1)
    paths.set(short, node.path)
    paths.set(fullToken(node.path), node.path)
    node.children.forEach(visit)
  }
  visit(tree)
  const tokenOf = (path: string) => {
    const short = shortOf(path)
    return counts.get(short) === 1 ? short : fullToken(path)
  }
  const pathOf = (token: string) => {
    const path = paths.get(token)
    return path !== undefined && tokenOf(path) === token ? path : undefined
  }
  return {tokenOf, pathOf}
}

export function folderIndex(tree: TreeNode) {
  const known = indexes.get(tree)
  if (known) return known
  const built = buildIndex(tree)
  indexes.set(tree, built)
  return built
}

export function zoomedPath(tree: TreeNode, token: string) {
  return folderIndex(tree).pathOf(token) ?? nearestFolder(tree, knownPathOf(token) ?? tree.path)
}

export function zoomLink(tree: TreeNode, path: string) {
  if (path === tree.path) return linkOptions({to: '/storage', search: true})
  return linkOptions({to: '/storage/$folder', params: {folder: folderIndex(tree).tokenOf(path)}, search: true})
}
