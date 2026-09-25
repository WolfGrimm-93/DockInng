// Tabs (Base UI): estilo subrayado de la plantilla (.tabs/.tab). Roving tabindex y flechas/Home/End incluidos.
// Contrato: <Tabs value onValueChange><TabsList aria-label><TabsTab value>…</TabsTab></TabsList><TabsPanel value>…</TabsPanel></Tabs>
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return <TabsPrimitive.List className={cn("tabs", className)} activateOnFocus {...props} />
}
function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return <TabsPrimitive.Tab className={cn("tab", className)} {...props} />
}
function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel className={className} {...props} />
}

export { Tabs, TabsList, TabsTab, TabsPanel }
