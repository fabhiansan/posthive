"use client";

import type { DesignTemplate } from "./templates";
import { useDashboard, type DashboardState } from "./useDashboard";

export type TemplateList = { templates: DesignTemplate[] };

/**
 * The templates of the workspace, newest change first. The API decides who sees what: the design team gets drafts
 * and published templates, everyone else only the published ones, so a page never has to filter drafts out.
 */
export function useTemplates(): DashboardState<TemplateList> {
  return useDashboard<TemplateList>("/templates");
}
