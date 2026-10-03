// Every scene, by name: what test/scenes.mts renders to prove each one
// still renders without the app, and what the marketing site shows.
import {
  DetailBadgerScene,
  DetailHummingbirdScene,
  LaunchRowScene,
} from "./DetailScene";
import { RowScene } from "./RowScene";

export const scenes = {
  row: RowScene,
  detailHummingbird: DetailHummingbirdScene,
  detailBadger: DetailBadgerScene,
  launchRow: LaunchRowScene,
};
