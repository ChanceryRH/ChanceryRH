// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/ChanceryRegistry.sol";

contract TokenMock {
    mapping(address=>uint256) public balanceOf;
    bool public falseTransfer;
    function mint(address to,uint256 amount) external {balanceOf[to]+=amount;}
    function setFalse(bool value) external {falseTransfer=value;}
    function move(address from,address to,uint256 amount) external {
        if(falseTransfer)return;
        require(balanceOf[from]>=amount,"balance");balanceOf[from]-=amount;balanceOf[to]+=amount;
    }
}
contract SafeMock {function getThreshold() external pure returns(uint256){return 1;}}
contract ModuleMock is IAllowanceModule {
    bytes public callback;
    bool public callbackSucceeded;
    bytes public callbackResult;
    mapping(address=>mapping(address=>uint96)) public caps;
    mapping(address=>mapping(address=>uint96)) public spent;
    mapping(address=>mapping(address=>uint32)) public starts;
    function setCallback(bytes calldata data) external {callback=data;}
    function set(address safe,address delegate,uint96 amount,uint32 start) external {caps[safe][delegate]=amount;starts[safe][delegate]=start;spent[safe][delegate]=0;}
    function getTokenAllowance(address safe,address delegate,address) public view returns(uint256[5] memory a){
        uint32 start=starts[safe][delegate];uint96 used=spent[safe][delegate];
        if(block.timestamp/60>=start+43200){start+=uint32((block.timestamp/60-start)/43200)*43200;used=0;}
        a=[uint256(caps[safe][delegate]),uint256(used),43200,uint256(start),0];
    }
    function executeAllowanceTransfer(address safe,address token,address payable to,uint96 amount,address paymentToken,uint96 payment,address delegate,bytes calldata signature) external {
        require(msg.sender==delegate && signature.length==0 && paymentToken==address(0) && payment==0,"signature");
        uint256[5] memory a=getTokenAllowance(safe,delegate,token);
        require(a[1]+amount<=a[0],"allowance");spent[safe][delegate]=uint96(a[1])+amount;starts[safe][delegate]=uint32(a[3]);
        if(callback.length>0) (callbackSucceeded,callbackResult)=delegate.call(callback);
        TokenMock(token).move(safe,to,amount);
    }
}
contract ChanceryRegistryTest is Test {
    ChanceryRegistry registry; TokenMock token; ModuleMock module; SafeMock safe;
    address operator=address(0x123); address treasury=address(0x456); bytes32 office;
    uint32 period; SettlementDelegate delegate;
    function setUp() public {
        vm.warp(1800000000);
        token=new TokenMock();module=new ModuleMock();safe=new SafeMock();
        registry=new ChanceryRegistry(address(token),treasury,address(module),address(this),operator);
        vm.prank(address(safe)); office=registry.open(bytes32(uint256(1)),bytes32(uint256(2)),100e6);
        delegate=SettlementDelegate(registry.delegates(office,bytes32(0)));period=uint32(block.timestamp/60);
        module.set(address(safe),address(delegate),100e6,period);token.mint(address(safe),1000e6);
    }
    function pay(SettlementDelegate d,bytes32 batch,uint96 amount) internal {
        vm.prank(operator); d.settle(batch,uint64(block.timestamp/1 days),period,keccak256(abi.encode(batch)),1,amount);
    }
    function clerk(bytes32 id,uint96 cap) internal returns(SettlementDelegate d) {
        vm.prank(address(safe));address deployed=registry.setClerk(office,id,true);
        d=SettlementDelegate(deployed);module.set(address(safe),deployed,cap,period);
    }
    function testTransferAndLogAreAtomic() public {
        pay(delegate,bytes32(uint256(1)),7e6);
        assertEq(token.balanceOf(treasury),7e6);assertEq(token.balanceOf(address(safe)),993e6);
        (,uint96 used,)=registry.budget(office);assertEq(used,7e6);
        assertTrue(registry.settlementLog().recorded(keccak256(abi.encode(office,bytes32(0),bytes32(uint256(1))))));
    }
    function testReentrantOperatorCannotSettleTwice() public {
        // Even an authorized contract operator cannot nest settlement during the module call.
        operator=address(module);registry.setOperator(operator);
        module.setCallback(abi.encodeCall(delegate.settle,(bytes32(uint256(2)),uint64(block.timestamp/1 days),period,bytes32(uint256(99)),1,7e6)));
        pay(delegate,bytes32(uint256(1)),7e6);
        assertFalse(module.callbackSucceeded());
        assertEq(module.callbackResult(),abi.encodeWithSignature("Error(string)","reentrant"));
        assertFalse(delegate.settled(bytes32(uint256(2))));
        (,uint96 used,)=registry.budget(office);assertEq(used,7e6);
        assertEq(token.balanceOf(treasury),7e6);
        module.setCallback("");pay(delegate,bytes32(uint256(2)),7e6);
        assertEq(token.balanceOf(treasury),14e6);
    }
    function testDuplicateRejected() public {pay(delegate,bytes32(uint256(1)),7e6);vm.expectRevert("duplicate batch");pay(delegate,bytes32(uint256(1)),7e6);}
    function testSameReceiptsWithNewBatchRejected() public {
        pay(delegate,bytes32(uint256(1)),7e6);
        vm.prank(operator);vm.expectRevert("duplicate receipts");delegate.settle(bytes32(uint256(2)),uint64(block.timestamp/1 days),period,keccak256(abi.encode(bytes32(uint256(1)))),1,7e6);
    }
    function testOperatorCannotSpendThroughModuleDirectly() public {
        vm.prank(operator);vm.expectRevert("signature");module.executeAllowanceTransfer(address(safe),address(token),payable(treasury),1,address(0),0,address(delegate),"");
    }
    function testWrongCallerCannotSettle() public {
        vm.expectRevert("operator only");delegate.settle(bytes32(uint256(1)),1,period,bytes32(uint256(9)),1,1);
    }
    function testOnlySafeCanChangeOffice() public {
        vm.expectRevert("Safe only");registry.setCap(office,1);
        vm.expectRevert("Safe only");registry.setSeats(office,bytes32(uint256(4)));
        vm.expectRevert("Safe only");registry.close(office);
    }
    function testOfficeCapCoversAllClerks() public {
        SettlementDelegate a=clerk(bytes32(uint256(1)),100e6);SettlementDelegate b=clerk(bytes32(uint256(2)),100e6);
        pay(a,bytes32(uint256(1)),60e6);pay(b,bytes32(uint256(1)),40e6);
        vm.expectRevert("Office cap");pay(delegate,bytes32(uint256(1)),1);
    }
    function testCloseStopsEveryDelegate() public {
        SettlementDelegate a=clerk(bytes32(uint256(1)),100e6);
        vm.prank(address(safe));registry.close(office);
        vm.expectRevert("inactive");pay(delegate,bytes32(uint256(1)),1);
        vm.expectRevert("inactive");pay(a,bytes32(uint256(1)),1);
    }
    function testRevokedClerkCannotSettle() public {
        SettlementDelegate a=clerk(bytes32(uint256(1)),100e6);
        vm.prank(address(safe));registry.setClerk(office,bytes32(uint256(1)),false);
        vm.expectRevert("inactive");pay(a,bytes32(uint256(1)),1);
    }
    function testFalseTokenTransferRollsBackEverything() public {
        token.setFalse(true);vm.expectRevert("transfer mismatch");pay(delegate,bytes32(uint256(1)),7e6);
        (,uint96 used,)=registry.budget(office);assertEq(used,0);assertFalse(delegate.settled(bytes32(uint256(1))));
        assertFalse(registry.settlementLog().recorded(keccak256(abi.encode(office,bytes32(0),bytes32(uint256(1))))));
    }
    function testAllowanceRemovalOrZeroStopsTransfer() public {
        module.set(address(safe),address(delegate),0,period);vm.expectRevert("allowance");pay(delegate,bytes32(uint256(1)),1);
        (,uint96 used,)=registry.budget(office);assertEq(used,0);
    }
    function testPeriodMismatchRejected() public {
        module.set(address(safe),address(delegate),100e6,period-1);vm.expectRevert("module period mismatch");pay(delegate,bytes32(uint256(1)),1);
    }
    function testResetAndStalePeriod() public {
        pay(delegate,bytes32(uint256(1)),100e6);vm.warp(block.timestamp+30 days);
        vm.expectRevert("stale period");pay(delegate,bytes32(uint256(2)),1);
        period+=43200;pay(delegate,bytes32(uint256(2)),100e6);
        (,uint96 used,uint32 current)=registry.budget(office);assertEq(used,100e6);assertEq(current,period);
    }
    function testCannotForgeLogOrBudgetConsumption() public {
        vm.expectRevert("delegate only");registry.consume(office,bytes32(0),1,period);
        SettlementLog log=registry.settlementLog();
        vm.expectRevert("delegate only");log.record(office,bytes32(0),bytes32(uint256(1)),1,1,bytes32(uint256(2)),1,period);
    }
    function testPredictedDelegateIsCorrect() public view {assertEq(registry.delegateAddress(address(safe),bytes32(0)),address(delegate));}
    function testFuzzCapConservation(uint96 amount) public {
        amount=uint96(bound(amount,1,100e6));pay(delegate,bytes32(uint256(1)),amount);
        (,uint96 used,)=registry.budget(office);assertEq(used,amount);assertEq(token.balanceOf(treasury),amount);
    }
}
