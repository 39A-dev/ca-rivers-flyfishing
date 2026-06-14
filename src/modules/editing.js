import Editor from "@arcgis/core/widgets/Editor.js";
import Expand from "@arcgis/core/widgets/Expand.js";
import { LAYERS } from "../config.js";

/**
 * Field-data editing for the three editable layers:
 *   • BMI sample sites          (add new samples)
 *   • Stream-health readings     (add new readings)
 *   • Road closures / access     (override published condition in the field)
 *
 * The Editor widget gives a full add/update/delete form per layer. We supply a
 * tailored form template for the road layer so the "field-verified override"
 * workflow is front-and-center.
 *
 * NOTE: editing private layers requires sign-in — see src/auth.js. Public layers
 * that allow anonymous edits work as-is.
 */
export function createEditor(view, layers) {
  const layerInfos = [];

  if (layers.bmi) {
    layerInfos.push({ layer: layers.bmi });
  }
  if (layers.health) {
    layerInfos.push({ layer: layers.health });
  }
  if (layers.roads) {
    layerInfos.push({
      layer: layers.roads,
      formTemplate: roadFormTemplate(),
    });
  }

  if (!layerInfos.length) {
    // No editable layers configured yet — don't add an empty widget.
    return null;
  }

  const editor = new Editor({
    view,
    layerInfos,
    label: "Field data entry",
  });

  const expand = new Expand({
    view,
    content: editor,
    expandIcon: "pencil",
    expandTooltip: "Add / edit field data",
    group: "top-left",
  });
  view.ui.add(expand, "top-left");
  return editor;
}

/**
 * Road form: emphasize the override fields. `published_status` is shown
 * read-only (it comes from the official feed); the crew edits `field_status`,
 * `verified_by`, `verified_date`, and `notes`.
 */
function roadFormTemplate() {
  const f = LAYERS.roads.fields;
  return {
    title: "Road condition (field override)",
    elements: [
      {
        type: "field",
        fieldName: f.publishedStatus,
        label: "Published status (from official source)",
        editable: false,
      },
      {
        type: "field",
        fieldName: f.fieldStatus,
        label: "Field-verified status",
        description: "What you actually observed on the ground.",
      },
      { type: "field", fieldName: f.verifiedBy, label: "Verified by" },
      { type: "field", fieldName: f.verifiedDate, label: "Verified date" },
      { type: "field", fieldName: f.notes, label: "Condition notes" },
    ],
  };
}
