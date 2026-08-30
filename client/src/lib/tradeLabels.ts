// v20.41.0 — shared trade taxonomy labels, extracted from RepairConsultSheet.tsx
// so Phase 2's Labor Calculator (LaborCalculatorModal.tsx) can render the same
// human-readable trade names as the consult sheet without duplicating the map
// and risking drift between the two.
export const TRADE_LABELS: Record<string, string> = {
  junk_removal: "Junk Removal", handyman: "Handyman", pressure_washing: "Pressure Washing",
  painting_exterior: "Exterior Painting", landscaping: "Landscaping", painting_interior: "Interior Painting",
  cleaning: "Cleaning",
  tile_install: "Tile Installation", cabinet_install: "Cabinet Installation", cabinetry_painting: "Cabinetry Painting",
  roofing: "Roofing", electrical: "Electrical", plumbing: "Plumbing", hvac: "HVAC",
  stucco_masonry: "Stucco & Masonry", carpentry: "Carpentry", wdo: "WDO / Termite",
  windows: "Windows", backflow: "Backflow Prevention", flooring_wood_refinish: "Wood Floor Refinishing",
  flooring_lvp: "LVP Flooring", flooring_carpet: "Carpet Installation", flooring_epoxy: "Epoxy Flooring", appliances: "Appliances",
  countertops: "Countertops", retexture: "Re-Texturing", shower_doors: "Frameless Shower Doors",
  irrigation: "Irrigation", fencing: "Fencing", pool_equipment: "Pool Equipment", septic: "Septic",
  water_heater: "Water Heater", tree_removal_large: "Large Tree Removal", structural: "Structural / Foundation",
  mold_remediation: "Mold Remediation", chimney: "Chimney", solar: "Solar", water_damage: "Water Damage Restoration",
  garage_door: "Garage Door", hardscape: "Hardscape / Pavers", land_clearing: "Land Clearing",
  bathroom_repair: "Bathroom Repairs", kitchen_repair: "Kitchen Repairs", laundry_repair: "Laundry Room",
  appliance_coordination: "Materials, Appliance Purchase & Delivery",
};
