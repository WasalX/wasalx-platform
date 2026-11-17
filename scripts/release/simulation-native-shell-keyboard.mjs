// Installed QuickSearchInput activates the sidebar Tab trap on focus. Its native
// Escape handler resets search and blurs the input; continue keyboard navigation.
export async function dismissNativeQuickSearch(page){
 const reset=page.locator('#main-sidebar').getByRole('button',{name:'Reset search',exact:true});
 if(await reset.isVisible()){
  await page.keyboard.press('Escape');
  await reset.waitFor({state:'hidden',timeout:5000});
  return true;
 }
 return false;
}
