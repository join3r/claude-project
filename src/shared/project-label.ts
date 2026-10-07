/**
 * A project's tile and a task's `project › stream` place. The derivation lives in
 * `protocol/ts/project-tile.ts` because the phone has to match it exactly (SPEC.md §10).
 */
export {
  PROJECT_TILE_PALETTE,
  projectTile,
  projectSwatch,
  projectHue,
  projectInitials,
  taskPlace,
  type ProjectTile,
  type ProjectTileSwatch
} from '../../protocol/ts/project-tile.ts'
