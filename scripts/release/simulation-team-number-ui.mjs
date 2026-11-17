import assert from 'node:assert/strict';

// Existing MemberAccessDialog controls, English desktop; no authentication parser.
export function createTeamNumberUi({page,origin}) {
  const open=async member=>{
    await page.goto(origin+'/app?view=team');
    const row=page.getByRole('row').filter({has:page.getByText(member.email,{exact:true})});
    await row.getByRole('button',{name:'Manage',exact:true}).click({timeout:15000});
    await page.locator('#member-whatsapp').waitFor({state:'visible',timeout:10000});
  };
  const submit=async(member,numbers)=>{
    await open(member);await page.locator('#member-whatsapp').fill(numbers.join('\n'));
    const [response]=await Promise.all([
      page.waitForResponse(r=>new URL(r.url()).pathname===`/api/team/members/${member.id}`&&r.request().method()==='PATCH',{timeout:20000}),
      page.getByRole('button',{name:'Save access',exact:true}).click()
    ]);return response.status();
  };
  const inspectRejection=async({member,numbers,status})=>{
    assert.equal(status,400,'This UI check is only the source-defined client validation boundary');
    await open(member);await page.locator('#member-whatsapp').fill(numbers.join('\n'));
    const path=`/api/team/members/${member.id}`;let attempts=0;
    const guard=async route=>{const request=route.request();if(request.method()==='PATCH'&&new URL(request.url()).pathname===path){attempts++;await route.abort('blockedbyclient');}else await route.fallback();};
    await page.route('**/api/team/members/*',guard);
    try{
      await page.getByRole('button',{name:'Save access',exact:true}).click();
      const alert=page.getByRole('alert');await alert.waitFor({state:'visible',timeout:10000});
      const actionableNumberFeedback=/number|international|duplicate/i.test(await alert.innerText());
      assert.equal(attempts,0,'Client validation unexpectedly attempted a membership write');
      const proof={clientValidation:true,apiExpectedStatus:status,patchAttempts:attempts,visible:true,actionableNumberFeedback,at:new Date().toISOString()};
      await page.goto(origin+'/app?view=team');assert.equal(attempts,0);return proof;
    }finally{await page.unroute('**/api/team/members/*',guard);}
  };
  return {
    inspectRejection,
    save:async({member,numbers})=>{
      assert.equal(await submit(member,numbers),200);
      await page.locator('#member-whatsapp').waitFor({state:'hidden',timeout:10000});
    },
    reload:async({member,expected})=>{
      await open(member);assert.deepEqual((await page.locator('#member-whatsapp').inputValue()).split('\n').filter(Boolean),expected);
      await page.getByRole('button',{name:'Close member access',exact:true}).click();
      return {renderedAfterNavigation:true,count:expected.length,matched:true};
    },
    reject:async({member,numbers,status,requireActionable=false})=>{
      const proof=await inspectRejection({member,numbers,status});
      if(requireActionable)assert(proof.actionableNumberFeedback);return proof;
    }
  };
}
